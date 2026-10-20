import { z } from "zod";
import type { ResponseInputItem, Tool } from "../../packages/provider/index.ts";
import type { ProviderContinuation } from "../../packages/provider/continuation.ts";
import { TranscriptItem } from "../../packages/provider/compaction.ts";
import { nativeHash, validateNative } from "../../packages/provider/anthropic-context-frames.ts";
import { NativeContextError, type NativeContextState } from "../../packages/provider/native-context.ts";

const Interruption = z.object({ kind: z.literal("inference_interrupted"), response_id: z.string() });
const Arguments = z.record(z.string(), z.unknown());
type ContinuationHistory = {
  readonly runId: string;
  readonly input: ResponseInputItem[];
  readonly tools: Tool[];
  readonly seenCallIds: ReadonlySet<string>;
  readonly native: boolean;
};
type ContinuationResult =
  | { readonly kind: "empty" | "duplicate" }
  | { readonly kind: "invalid"; readonly reason: string }
  | {
      readonly kind: "preserved";
      readonly input: ResponseInputItem[];
      readonly callIds: readonly string[];
      readonly nativeContext?: NativeContextState;
    };

export function interruptedContinuation(
  snapshot: ProviderContinuation | undefined,
  history: ContinuationHistory,
): ContinuationResult {
  if (!snapshot?.output.length) return { kind: "empty" };
  for (const item of history.input) {
    if (!("role" in item) || item.role !== "user" || !("content" in item) || typeof item.content !== "string" || !item.content.startsWith('{"kind":"inference_interrupted"')) continue;
    try {
      const marker = Interruption.safeParse(JSON.parse(item.content));
      if (marker.success && marker.data.response_id === snapshot.responseId) return { kind: "duplicate" };
    } catch (error) { if (!(error instanceof SyntaxError)) throw error; }
  }
  const calls = new Set<string>();
  const output: ResponseInputItem[] = [];
  for (const item of snapshot.output) {
    const parsed = TranscriptItem.safeParse(item);
    if (!parsed.success) return { kind: "invalid", reason: "invalid_item" };
    switch (item.type) {
      case "reasoning":
        if (!item.encrypted_content || item.status === "in_progress" || item.status === "incomplete") return { kind: "invalid", reason: "unfinished_reasoning" };
        break;
      case "compaction": break;
      case "message":
        if (item.role !== "assistant") return { kind: "invalid", reason: "invalid_role" };
        break;
      case "function_call": {
        if (history.seenCallIds.has(item.call_id) || calls.has(item.call_id)) return { kind: "invalid", reason: "reused_call_id" };
        if (!item.call_id.trim() || !item.name.trim() || item.status === "in_progress" || item.status === "incomplete") return { kind: "invalid", reason: "unfinished_call" };
        try {
          if (!Arguments.safeParse(JSON.parse(item.arguments)).success) return { kind: "invalid", reason: "invalid_arguments" };
        } catch (error) {
          if (error instanceof SyntaxError) return { kind: "invalid", reason: "invalid_arguments" };
          throw error;
        }
        calls.add(item.call_id);
        break;
      }
      default: return { kind: "invalid", reason: "unsupported_item" };
    }
    output.push(parsed.data);
  }
  for (const callId of calls) output.push({
    type: "function_call_output", call_id: callId,
    output: JSON.stringify({ executed: false, status: "not_executed", error: { code: "interrupted_before_execution" }, reason: "new_user_input" }),
  });
  output.push({ role: "user", content: JSON.stringify({
    kind: "inference_interrupted", response_id: snapshot.responseId,
    delivered: false, tools_executed: false,
    instruction: "The preceding assistant output was interrupted by new input and was not delivered as an answer. Its tool calls were not executed. Keep the preserved context, read the following user updates, and decide what to do next. Do not treat unfinished text as a completed answer or replay earlier completed actions.",
  }) });
  const input = [...history.input, ...output];
  if (history.native !== Boolean(snapshot.nativeContext)) return { kind: "invalid", reason: "native_state_missing" };
  if (snapshot.nativeContext) {
    const state = snapshot.nativeContext, reply = state.reply;
    if (!reply || reply.from !== history.input.length || reply.to !== history.input.length + snapshot.output.length || reply.hash !== nativeHash(snapshot.output)) return { kind: "invalid", reason: "native_reply_mismatch" };
    try { validateNative({ runId: history.runId, input, tools: history.tools, state, signal: new AbortController().signal }, state.model); }
    catch (error) {
      if (error instanceof NativeContextError) return { kind: "invalid", reason: error.code };
      throw error;
    }
  }
  return { kind: "preserved", input, callIds: [...calls], ...(snapshot.nativeContext ? { nativeContext: snapshot.nativeContext } : {}) };
}
