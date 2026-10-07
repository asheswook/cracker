import { test, expect } from "bun:test";
import type { Response, ResponseStreamEvent, ResponseOutputItem } from "openai/resources/responses/responses";
import { consumeResponse } from "../packages/provider/index.ts";
const terminal: Response = { id: "fixture", created_at: 0, output_text: "", error: null, incomplete_details: null, instructions: null, metadata: null, model: "fixture", object: "response", output: [], parallel_tool_calls: false, temperature: null, tool_choice: "auto", tools: [], top_p: null, status: "completed" };
async function* stream(events: readonly ResponseStreamEvent[]): AsyncGenerator<ResponseStreamEvent> { yield* events; }
const message: ResponseOutputItem = { type: "message", id: "message", role: "assistant", status: "completed", content: [{ type: "output_text", text: "Hello!", annotations: [] }] };
test("OAuth done-item survives empty completed snapshot", async () => {
  // Given actual observed OAuth wire shape: done carries content, terminal output is empty.
  const events: ResponseStreamEvent[] = [ { type: "response.output_item.done", output_index: 0, sequence_number: 1, item: message }, { type: "response.completed", sequence_number: 2, response: terminal } ];
  // When
  const result = await consumeResponse(stream(events));
  // Then
  expect(result.output_text).toBe("Hello!"); expect(result.output).toEqual([message]);
});
test("tool call survives empty terminal snapshot", async () => {
  // Given
  const call: ResponseOutputItem = { type: "function_call", name: "shell", call_id: "call", arguments: '{"command":"pwd"}', id: "tool" };
  // When
  const result = await consumeResponse(stream([{ type: "response.output_item.done", output_index: 0, sequence_number: 1, item: call }, { type: "response.completed", sequence_number: 2, response: terminal }]));
  // Then
  expect(result.output).toEqual([call]);
});
test("done items without completion remain a failed response", async () => {
  // Given
  const events: ResponseStreamEvent[] = [{ type: "response.output_item.done", output_index: 0, sequence_number: 1, item: message }];
  // When / Then
  await expect(consumeResponse(stream(events))).rejects.toThrow("before response.completed");
});
