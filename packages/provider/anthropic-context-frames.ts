import type { BetaMessageParam } from "@anthropic-ai/sdk/resources/beta/messages/messages";
import { anthropicTools, anthropicTranscript } from "./anthropic-messages.ts";
import {
  NativeContextError,
  type NativeContextRequest,
  type NativeContextState,
} from "./native-context.ts";

export function nativeHash(value: unknown): string {
  return new Bun.CryptoHasher("sha256").update(JSON.stringify(value)).digest("hex");
}

export function validateNative(request: NativeContextRequest, model: string): void {
  const state = request.state;
  if (!state) return;
  if (state.runId !== request.runId) throw new NativeContextError("run_changed");
  if (state.model !== model) throw new NativeContextError("model_changed");
  if (state.toolsHash !== nativeHash(anthropicTools(request.tools)))
    throw new NativeContextError("prefix_changed");
  let end = state.compactedThrough;
  if (end + (state.archive?.through ?? 0) > 0 !== Boolean(state.summary))
    throw new NativeContextError("invalid_frame");
  for (const frame of state.frames) {
    if (
      frame.from !== end ||
      frame.to <= frame.from ||
      frame.to > request.input.length ||
      frame.hash !== nativeHash(request.input.slice(frame.from, frame.to))
    )
      throw new NativeContextError("invalid_frame");
    const transcript = anthropicTranscript(request.input.slice(frame.from, frame.to), model);
    if (
      frame.initial &&
      (frame.from !== 0 || nativeHash(transcript.system) !== nativeHash(state.system))
    )
      throw new NativeContextError("prefix_changed");
    end = frame.to;
  }
  for (const reply of [
    ...state.frames.flatMap((frame) => (frame.reply ? [frame.reply] : [])),
    ...(state.reply ? [state.reply] : []),
  ]) {
    if (
      reply.to > request.input.length ||
      reply.to <= reply.from ||
      nativeHash(request.input.slice(reply.from, reply.to)) !== reply.hash
    )
      throw new NativeContextError("invalid_frame");
  }
  if (end > request.input.length) throw new NativeContextError("invalid_frame");
}

export function nativeMessages(
  input: NativeContextRequest["input"],
  state: NativeContextState,
): BetaMessageParam[] {
  const messages: BetaMessageParam[] = state.summary
    ? [{ role: "assistant", content: [state.summary] }]
    : [];
  for (const frame of state.frames) {
    const transcript = anthropicTranscript(input.slice(frame.from, frame.to), state.model);
    if (frame.reply) {
      const assistant = transcript.messages[0];
      if (!assistant || assistant.role !== "assistant" || frame.reply.from !== frame.from)
        throw new NativeContextError("invalid_frame");
      assistant.content = frame.reply.content;
    }
    messages.push(...transcript.messages);
    const instructions = [
      ...frame.extraSystem,
      ...(frame.initial ? [] : transcript.system),
      { type: "text" as const, text: frame.clock },
    ];
    messages.push({ role: "system", content: instructions });
  }
  return messages;
}

export function prepareNative(
  request: NativeContextRequest & { readonly clock: string },
  model: string,
): NativeContextState {
  validateNative(request, model);
  const previous = request.state;
  const from = previous?.frames.at(-1)?.to ?? previous?.compactedThrough ?? 0;
  if (from >= request.input.length) throw new NativeContextError("invalid_frame");
  const transcript = anthropicTranscript(request.input.slice(from), model);
  if (previous && transcript.messages[0]?.role !== "assistant")
    throw new NativeContextError("invalid_frame");
  const frame = {
    from,
    to: request.input.length,
    hash: nativeHash(request.input.slice(from)),
    initial: !previous,
    clock: request.clock,
    extraSystem: previous?.pendingSystem ?? [],
    ...(previous?.reply ? { reply: previous.reply } : {}),
  };
  const state: NativeContextState = {
    version: 1,
    provider: "anthropic",
    runId: request.runId,
    model: model,
    system: previous?.system ?? transcript.system,
    toolsHash: previous?.toolsHash ?? nativeHash(anthropicTools(request.tools)),
    compactedThrough: previous?.compactedThrough ?? 0,
    ...(previous?.archive ? { archive: previous.archive } : {}),
    ...(previous?.summary ? { summary: previous.summary } : {}),
    pendingSystem: [],
    frames: [...(previous?.frames ?? []), frame],
  };
  return state;
}
