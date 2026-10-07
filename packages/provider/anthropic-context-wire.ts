import type {
  MessageCountTokensParams,
  MessageCreateParamsStreaming,
} from "@anthropic-ai/sdk/resources/beta/messages/messages";
import { anthropicTools } from "./anthropic-messages.ts";
import { nativeMessages } from "./anthropic-context-frames.ts";
import {
  NativeContextError,
  type NativeContextRequest,
  type NativeContextState,
} from "./native-context.ts";

export const CLAUDE_REQUEST_BYTES = 32_000_000;
export class NativeBodyError extends NativeContextError {
  constructor(readonly bytes: number) {
    super("request_body_too_large");
  }
}
export function admitNativeBody<T>(body: T): T {
  const bytes = Buffer.byteLength(JSON.stringify(body), "utf8");
  if (bytes > CLAUDE_REQUEST_BYTES) throw new NativeBodyError(bytes);
  return body;
}
export function nativeMessageBody(
  request: NativeContextRequest,
  state: NativeContextState,
  outputTokens: number,
  summarize = false,
): MessageCreateParamsStreaming {
  return admitNativeBody({
    model: state.model,
    max_tokens: outputTokens,
    stream: true,
    system: state.system,
    tools: anthropicTools(request.tools),
    messages: nativeMessages(request.input, state),
    service_tier: "standard_only",
    ...(summarize
      ? { compaction: { type: "summarize" as const } }
      : { tool_choice: { type: "auto" as const, disable_parallel_tool_use: false } }),
  });
}
export function nativeCountBody(
  request: NativeContextRequest,
  state: NativeContextState,
): MessageCountTokensParams {
  const messages = nativeMessages(request.input, state);
  for (const message of messages) {
    if (typeof message.content === "string") continue;
    for (const block of message.content) {
      const blocks =
        block.type === "tool_result" && Array.isArray(block.content) ? block.content : [block];
      if (
        blocks.some(
          (part) =>
            (part.type === "image" || part.type === "document") && part.source.type === "url",
        )
      )
        throw new NativeContextError("uncountable_media");
    }
  }
  return admitNativeBody({
    model: state.model,
    system: state.system,
    tools: anthropicTools(request.tools),
    messages,
    tool_choice: { type: "auto", disable_parallel_tool_use: false },
  });
}
