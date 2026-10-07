import { z } from "zod";
import { Assignment } from "../../packages/protocol/index.ts";
import type { Provider, ResponseInputItem } from "../../packages/provider/index.ts";
import { compactedInput, completeToolBoundary, TranscriptItem } from "../../packages/provider/compaction.ts";
import { NativeContextState } from "../../packages/provider/native-context.ts";
import { SemanticCheckpoint } from "./semantic-context-state.ts";

export const ArtifactCheckpoint = z.object({ directory: z.string().min(1), seen: z.array(z.string()), inlineBytes: z.number().int().nonnegative() });
export const RunCheckpoint = z.object({
  argumentRepairs:z.number().int().min(0).max(2).optional(),
  appliedInputIds:z.array(z.uuid()).max(100).optional(),
  nativeContext: NativeContextState.optional(),
  semanticContext: SemanticCheckpoint.optional(),
  version: z.literal(1), assignment: Assignment, input: z.array(TranscriptItem), cursor: z.number().int().nonnegative(),
  seenCallIds: z.array(z.string()), toolImageIndexes: z.array(z.number().int().nonnegative()).optional(), artifacts: ArtifactCheckpoint, inputTokens: z.number().nonnegative(),
});
export type RunCheckpoint = z.infer<typeof RunCheckpoint>;
export class ContextError extends Error { constructor(readonly code: "incomplete_tool_boundary" | "compaction_lost_user_input") { super(code); this.name = "ContextError"; } }
// Binary/opaque encodings are not text tokens. Their cost comes from provider usage;
// server compaction handles new media. Counting base64 caused needless compact calls.
export const DEFAULT_COMPACT_THRESHOLD = 64000;
export function contextBudget(input: readonly ResponseInputItem[], measuredTokens: number): number {
  const text = JSON.stringify(input, (key: string, value: unknown) =>
    key === 'image_url' || key === 'file_data' || key === 'encrypted_content' ? undefined : value);
  return Math.max(measuredTokens, Buffer.byteLength(text, "utf8"));
}
function userContent(item: ResponseInputItem): string | undefined {
  if (!("role" in item) || item.role !== "user" || !("content" in item)) return undefined;
  return JSON.stringify(typeof item.content === "string" ? [{ type: "input_text", text: item.content }] : item.content);
}
export async function compactContext(provider: Provider, state: { readonly input: ResponseInputItem[]; readonly signal: AbortSignal }): Promise<ResponseInputItem[]> {
  if (!provider.compact) return state.input;
  if (!completeToolBoundary(state.input)) throw new ContextError("incomplete_tool_boundary");
  const instructions = state.input.filter(item => "role" in item && (item.role === "system" || item.role === "developer"));
  const conversation = state.input.filter(item => !("role" in item) || (item.role !== "system" && item.role !== "developer"));
  const output = compactedInput({ object: "response.compaction", output: await provider.compact(conversation, state.signal) });
  state.signal.throwIfAborted();
  const users = output.flatMap(item => { const content = userContent(item); return content === undefined ? [] : [content]; });
  let index = 0;
  for (const item of conversation) {
    const content = userContent(item);
    if (content !== undefined && users[index++] !== content) throw new ContextError("compaction_lost_user_input");
  }
  if (index !== users.length) throw new ContextError("compaction_lost_user_input");
  // The canonical window is never sliced or rebuilt. Policy/provenance lives outside that window.
  return [...instructions, ...output];
}

export function compactedServerWindow(input: ResponseInputItem[], responseStart = 0): ResponseInputItem[] {
  for(let index=input.length-1;index>=responseStart;index--){
    if(input[index]?.type!=="compaction")continue;
    const suffix=input.slice(index);
    // A trailing compaction can precede local outputs for calls it swallowed. Keep an earlier
    // boundary until the server returns a window with a complete explicit call/output suffix.
    if(!completeToolBoundary(suffix))continue;
    const instructions=input.slice(0,index).filter(item=>"role" in item&&(item.role==="system"||item.role==="developer"));
    return [...instructions,...suffix];
  }
  return input;
}
