import Anthropic from "@anthropic-ai/sdk";
import type { Response, ResponseInputItem, Tool } from "openai/resources/responses/responses";
import type { Provider, ProviderResponseObserver } from "./index.ts";
import { ProviderError } from "./errors.ts";
import { anthropicResponse, anthropicTools, anthropicTranscript } from "./anthropic-messages.ts";
import { AnthropicNativeContext } from "./anthropic-context.ts";

export type AnthropicProviderConfig = {
  readonly model: string;
  readonly apiKey: string;
  readonly maxTokens?: number;
};

export class AnthropicProvider implements Provider {
  readonly nativeContext: AnthropicNativeContext;
  readonly standaloneCompaction = false;
  private readonly client: Anthropic;
  private readonly flights = new Set<AbortController>();
  private closed = false;
  constructor(
    private readonly config: AnthropicProviderConfig,
    client?: Anthropic,
  ) {
    if (!config.model.trim() || !config.apiKey.trim())
      throw new ProviderError("configuration", "Claude requires a model and ANTHROPIC_API_KEY");
    if (
      config.maxTokens !== undefined &&
      (!Number.isSafeInteger(config.maxTokens) || config.maxTokens < 1)
    )
      throw new ProviderError("configuration", "Claude maxTokens must be a positive integer");
    this.client =
      client ?? new Anthropic({ apiKey: config.apiKey, maxRetries: 0, timeout: 120000 });
    this.nativeContext = new AnthropicNativeContext(this.client, config, (signal, work) => this.flight(signal, work));
  }
  private async flight<T>(signal: AbortSignal, work: (signal: AbortSignal) => Promise<T>): Promise<T> {
    if (this.closed) throw new ProviderError("configuration", "Provider is closed");
    signal.throwIfAborted();
    const controller = new AbortController();
    this.flights.add(controller);
    const combined = AbortSignal.any([signal, controller.signal]);
    try { const result = await work(combined); combined.throwIfAborted(); return result; }
    finally { controller.abort(); this.flights.delete(controller); }
  }
  close(): void {
    this.closed = true;
    for (const flight of this.flights) flight.abort();
  }
  async respond(
    input: ResponseInputItem[],
    tools: Tool[],
    signal: AbortSignal,
    observer?: ProviderResponseObserver,
  ): Promise<Response> {
    if (this.closed) throw new ProviderError("configuration", "Provider is closed");
    signal.throwIfAborted();
    const transcript = anthropicTranscript(input, this.config.model);
    const controller = new AbortController();
    this.flights.add(controller);
    let responseId: string | undefined;
    const textBlocks = new Set<number>();
    let stopped = false;
    try {
      const stream = this.client.messages.stream(
        {
          model: this.config.model,
          max_tokens: this.config.maxTokens ?? 16384,
          ...transcript,
          tools: anthropicTools(tools),
          tool_choice: { type: "auto", disable_parallel_tool_use: false },
          service_tier: "standard_only",
        },
        { signal: AbortSignal.any([signal, controller.signal]) },
      );
      for await (const event of stream) {
        if (event.type === "message_start") responseId = event.message.id;
        if (
          event.type === "content_block_delta" &&
          event.delta.type === "text_delta" &&
          event.delta.text.trim() &&
          responseId
        ) {
          textBlocks.add(event.index);
          observer?.({
            type: "text_delta",
            response_id: responseId,
            item_id: `${responseId}_${event.index}`,
          });
        }
        if (event.type === "content_block_stop" && textBlocks.delete(event.index) && responseId)
          observer?.({
            type: "text_done",
            response_id: responseId,
            item_id: `${responseId}_${event.index}`,
          });
        if (event.type === "message_stop") stopped = true;
      }
      if (!stopped)
        throw new ProviderError("incomplete", "Claude stream ended before message_stop");
      return anthropicResponse(await stream.finalMessage(), tools, this.config.model);
    } finally {
      controller.abort();
      this.flights.delete(controller);
      if (responseId) observer?.({ type: "response_done", response_id: responseId });
    }
  }
}
