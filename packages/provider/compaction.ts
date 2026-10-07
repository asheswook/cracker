import { z } from "zod";
import type { ResponseInputItem } from "./index.ts";
import { ProviderError } from "./errors.ts";

const Content = z.union([
  z.object({ type: z.literal("input_text"), text: z.string() }),
  z.object({ type: z.literal("input_image"), detail: z.enum(["auto", "low", "high", "original"]), image_url: z.string().nullish(), file_id: z.string().nullish() }),
  z.object({ type: z.literal("input_file"), file_data: z.string().optional(), file_id: z.string().optional(), file_url: z.string().optional(), filename: z.string().optional() }),
  z.object({ type: z.literal("output_text"), text: z.string(), annotations: z.array(z.unknown()) }),
  z.object({ type: z.literal("refusal"), refusal: z.string() }),
]);
const Item = z.union([
  z.object({ type: z.literal("message").optional(), role: z.enum(["user", "system", "developer", "assistant"]), content: z.union([z.string(), z.array(Content)]) }),
  z.object({ type: z.literal("compaction"), encrypted_content: z.string().min(1) }),
  z.object({ type: z.literal("reasoning"), id: z.string(), summary: z.array(z.object({ type: z.literal("summary_text"), text: z.string() })), encrypted_content: z.string().nullish() }),
  z.object({ type: z.literal("function_call"), call_id: z.string().min(1), name: z.string().min(1), arguments: z.string() }),
  z.object({ type: z.literal("function_call_output"), call_id: z.string().min(1), output: z.union([z.string(), z.array(Content)]) }),
]);
// Keep SDK fields and opaque bytes verbatim; the schema is a boundary check, not a transform.
export const TranscriptItem = z.custom<ResponseInputItem>(value => Item.safeParse(value).success);
export function completeToolBoundary(input: readonly ResponseInputItem[]): boolean {
  const calls = new Set<string>();
  for (const item of input) {
    if (item.type === "function_call") { if (calls.has(item.call_id)) return false; calls.add(item.call_id); }
    if (item.type === "function_call_output" && !calls.delete(item.call_id)) return false;
  }
  return calls.size === 0;
}
export function compactedInput(value: unknown): ResponseInputItem[] {
  const parsed = z.object({ object: z.literal("response.compaction"), output: z.array(TranscriptItem).min(1) }).safeParse(value);
  if (!parsed.success || !parsed.data.output.some(item => item.type === "compaction") || !completeToolBoundary(parsed.data.output))
    throw new ProviderError("incomplete", "Invalid compacted context");
  return parsed.data.output;
}
