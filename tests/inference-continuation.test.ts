import { expect, test } from "bun:test";
import type { ResponseInputItem, ResponseOutputItem } from "openai/resources/responses/responses";
import { interruptedContinuation } from "../services/daemon/inference-continuation.ts";
import { completeToolBoundary } from "../packages/provider/compaction.ts";

const reason = { type: "reasoning", id: "reason-a", summary: [], encrypted_content: "opaque-complete-a", status: "completed" } satisfies ResponseOutputItem;
const draft = { type: "message", id: "draft", role: "assistant", status: "incomplete", content: [{ type: "output_text", text: "An interrupted draft", annotations: [] }] } satisfies ResponseOutputItem;
const call = { type: "function_call", id: "call-item", call_id: "call-a", name: "unknown_but_never_executed", arguments: '{"target":"fixture"}', status: "completed" } satisfies ResponseOutputItem;
const input: ResponseInputItem[] = [{ role: "user", content: "First request" }];
const history = { runId: "fixture", input, tools: [], seenCallIds: new Set<string>(), native: false };

test("interrupted output preserves opaque reasoning and drafts with unexecuted call results", () => {
  const result = interruptedContinuation({ responseId: "response-a", output: [reason, draft, call] }, history);
  expect(result.kind).toBe("preserved");
  if (result.kind !== "preserved") return;
  expect(result.input.slice(1, 4)).toEqual([reason, draft, call]);
  expect(completeToolBoundary(result.input)).toBe(true);
  const skipped = result.input.find(item => item.type === "function_call_output");
  expect(skipped?.type === "function_call_output" && typeof skipped.output === "string" ? JSON.parse(skipped.output) : null).toMatchObject({ executed: false, status: "not_executed" });
  expect(result.callIds).toEqual(["call-a"]);
  expect(input).toHaveLength(1);
});

test("reapplying the same interruption does not duplicate its context or tool result", () => {
  const snapshot = { responseId: "response-a", output: [reason, call] };
  const first = interruptedContinuation(snapshot, history);
  expect(first.kind).toBe("preserved");
  if (first.kind !== "preserved") return;
  const second = interruptedContinuation(snapshot, { ...history, input: first.input, seenCallIds: new Set(first.callIds) });
  expect(second.kind).toBe("duplicate");
});

for (const [name, output, seen] of [
  ["unfinished reasoning", [{ ...reason, status: "incomplete" }], []],
  ["missing opaque reasoning", [{ ...reason, encrypted_content: null }], []],
  ["reused call identity", [reason, call], [call.call_id]],
  ["duplicate call identity", [reason, call, call], []],
  ["malformed call arguments", [reason, { ...call, arguments: '{"target":' }], []],
] satisfies [string, ResponseOutputItem[], string[]][]) {
  test(`invalid continuation rejects ${name} without changing history`, () => {
    const result = interruptedContinuation({ responseId: "response-a", output }, { ...history, seenCallIds: new Set(seen) });
    expect(result.kind).toBe("invalid");
    expect(history.input).toEqual(input);
    expect(history.seenCallIds.size).toBe(0);
  });
}

test("native output cannot be adopted without its matching native state", () => {
  expect(interruptedContinuation({ responseId: "response-a", output: [reason] }, { ...history, native: true })).toEqual({ kind: "invalid", reason: "native_state_missing" });
});
