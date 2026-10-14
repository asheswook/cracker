import { nativeMessageBody, nativeCountBody, NativeBodyError } from "./anthropic-context-wire.ts";
import { nativeHash, validateNative, prepareNative } from "./anthropic-context-frames.ts";
export { nativeMessages } from "./anthropic-context-frames.ts";
import type Anthropic from "@anthropic-ai/sdk";
import { z } from "zod";
import { anthropicTranscript, anthropicResponse } from "./anthropic-messages.ts";
import {
  NativeAssistantBlocks,
  NativeContextError,
  SignedSummary,
  type NativeContext,
  type NativeContextCapability,
  type NativeContextRequest,
  type NativeContextState,
} from "./native-context.ts";
import { ProviderError } from "./errors.ts";
import type { RetryBudget } from './retry.ts';

const inlineModels = new Set(["claude-fable-5-1", "claude-opus-5-5", "claude-sonnet-5-5"]);
const betas = ["compact-2026-09-04"];
const modelCapability = z.object({
  id: z.string(),
  max_input_tokens: z.number().int().positive(),
  max_tokens: z.number().int().positive(),
  capabilities: z
    .object({
      compaction: z
        .object({ supported: z.boolean(), summarize: z.object({ supported: z.boolean() }) })
        .nullish(),
    })
    .nullish(),
});
export class AnthropicNativeContext implements NativeContext {
  private cached: NativeContextCapability | undefined;
  constructor(
    private readonly client: Anthropic,
    private readonly config: { readonly model: string; readonly maxTokens?: number },
    private readonly flight: <T>(
      signal: AbortSignal,
      work: (signal: AbortSignal) => Promise<T>,
      budget?: RetryBudget,
    ) => Promise<T>,
  ) {}
  async capability(signal: AbortSignal): Promise<NativeContextCapability> {
    signal.throwIfAborted();
    if (this.cached) return this.cached;
    if (!inlineModels.has(this.config.model))
      return { kind: "unsupported", reason: "inline_system_unverified" };
    try {
      const result = await this.flight(signal, (signal) =>
        this.client.beta.models.retrieve(this.config.model, { betas }, { signal }),
      );
      const parsed = modelCapability.safeParse(result);
      if (!parsed.success) return { kind: "unsupported", reason: "capability_unavailable" };
      const info = parsed.data;
      if (info.id !== this.config.model)
        return { kind: "unsupported", reason: "model_identity_mismatch" };
      const compaction = info.capabilities?.compaction;
      this.cached =
        compaction?.supported && compaction.summarize.supported
          ? {
              kind: "supported",
              model: info.id,
              maxInputTokens: info.max_input_tokens,
              maxOutputTokens: info.max_tokens,
              outputTokenBudget: Math.min(this.config.maxTokens ?? 16384, info.max_tokens),
            }
          : { kind: "unsupported", reason: "summarize_unsupported" };
      return this.cached;
    } catch (error) {
      signal.throwIfAborted();
      if (error instanceof ProviderError) throw error;
      if (!(error instanceof Error)) throw error;
      return { kind: "unsupported", reason: "capability_unavailable" };
    }
  }
  async measure(request: NativeContextRequest & { readonly clock: string }): Promise<number> {
    const capability = await this.capability(request.signal);
    if (capability.kind !== "supported") throw new NativeContextError("unsupported_capability");
    const state = prepareNative(request, this.config.model);
    nativeMessageBody(request, state, capability.outputTokenBudget);
    const body = nativeCountBody(request, state);
    const count = await this.flight(request.signal, (signal) =>
      this.client.beta.messages.countTokens({ ...body, betas }, { signal }),
      request.budget,
    );
    const parsed = z.number().int().nonnegative().safeParse(count.input_tokens);
    if (!parsed.success) throw new NativeContextError("invalid_token_count");
    return parsed.data;
  }
  async respond(
    request: Parameters<NativeContext["respond"]>[0],
  ): ReturnType<NativeContext["respond"]> {
    const capability = await this.capability(request.signal);
    if (capability.kind !== "supported") throw new NativeContextError("unsupported_capability");
    const state = prepareNative(request, this.config.model);
    const response = await this.flight(request.signal, async (signal) => {
      const body = nativeMessageBody(request, state, capability.outputTokenBudget);
      const stream = this.client.beta.messages.stream({ ...body, betas }, { signal });
      let responseId: string | undefined,
        stopped = false;
      const textBlocks = new Set<number>();
      try {
        for await (const event of stream) {
          if (event.type === "message_start") responseId = event.message.id;
          if (
            event.type === "content_block_delta" &&
            event.delta.type === "text_delta" &&
            event.delta.text.trim() &&
            responseId
          ) {
            textBlocks.add(event.index);
            request.observer?.({
              type: "text_delta",
              response_id: responseId,
              item_id: `${responseId}_${event.index}`,
            });
          }
          if (event.type === "content_block_stop" && textBlocks.delete(event.index) && responseId)
            request.observer?.({
              type: "text_done",
              response_id: responseId,
              item_id: `${responseId}_${event.index}`,
            });
          if (event.type === "message_stop") stopped = true;
        }
        signal.throwIfAborted();
        if (!stopped)
          throw new ProviderError("incomplete", "Claude stream ended before message_stop");
        const message = await stream.finalMessage();
        if (message.input_transformations?.length)
          throw new ProviderError("incomplete", "Claude changed signed thinking ancestry");
        const response = anthropicResponse(message, request.tools, this.config.model);
        const output = response.output.filter(
          (item) =>
            item.type === "message" || item.type === "function_call" || item.type === "reasoning",
        );
        state.reply = {
          from: request.input.length,
          to: request.input.length + output.length,
          hash: nativeHash(output),
          content: NativeAssistantBlocks.parse(message.content),
        };
        return response;
      } finally {
        if (responseId) request.observer?.({ type: "response_done", response_id: responseId });
      }
    },request.budget);
    request.signal.throwIfAborted();
    return { response, state };
  }
  async compact(
    request: Parameters<NativeContext["compact"]>[0],
  ): ReturnType<NativeContext["compact"]> {
    const capability = await this.capability(request.signal);
    if (capability.kind !== "supported") throw new NativeContextError("unsupported_capability");
    validateNative(request, this.config.model);
    const state = request.state;
    let count = Math.max(1, state.frames.length - 1);
    let body: ReturnType<typeof nativeMessageBody> | undefined;
    while (count > 0) {
      try {
        body = nativeMessageBody(
          request,
          { ...state, frames: state.frames.slice(0, count) },
          capability.outputTokenBudget,
          true,
        );
        break;
      } catch (error) {
        if (!(error instanceof NativeBodyError)) throw error;
        count--;
      }
    }
    const removed = state.frames.slice(0, count),
      last = removed.at(-1);
    if (!body || !last || last.to >= request.input.length) return undefined;
    const tail = anthropicTranscript(request.input.slice(last.to), this.config.model);
    if (tail.messages[0]?.role !== "assistant") throw new NativeContextError("invalid_frame");
    const summaryBody = body;
    const result = await this.flight(request.signal, async (signal) => {
      const stream = this.client.beta.messages.stream({ ...summaryBody, betas }, { signal });
      let stopped = false;
      for await (const event of stream) if (event.type === "message_stop") stopped = true;
      signal.throwIfAborted();
      if (!stopped) throw new NativeContextError("invalid_summary");
      return stream.finalMessage();
    },request.budget);
    request.signal.throwIfAborted();
    if (
      result.model !== this.config.model ||
      result.stop_reason !== "compaction" ||
      result.content.length !== 1
    )
      throw new NativeContextError("invalid_summary");
    const summary = SignedSummary.safeParse(result.content[0]);
    if (!summary.success || !summary.data.content.trim())
      throw new NativeContextError("invalid_summary");
    const pendingSystem = [...state.pendingSystem];
    for (const frame of state.frames) {
      pendingSystem.push(...frame.extraSystem);
      if (!frame.initial)
        pendingSystem.push(
          ...anthropicTranscript(request.input.slice(frame.from, frame.to), this.config.model)
            .system,
        );
    }
    const reassertion = new Map<string, (typeof pendingSystem)[number]>();
    for (const instruction of pendingSystem) {
      reassertion.delete(instruction.text);
      reassertion.set(instruction.text, instruction);
    }
    return {
      ...state,
      summary: summary.data,
      compactedThrough: last.to,
      pendingSystem: [...reassertion.values()],
      frames: state.frames.slice(count),
    };
  }
}
