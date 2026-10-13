import { expect, test } from "bun:test";
import { fixture, message, wire } from "./anthropic-context-fixture.ts";
import type { ResponseInputItem } from "../packages/provider/index.ts";

for (const native of [false, true]) test(`Claude ${native ? "native" : "normal"} inference retries a transient 503 without changing request ancestry`, async () => {
  // Given a real loopback endpoint failing its first inference request.
  const f = fixture({ respond: (_body, index) => index === 1
    ? Response.json({ type: "error", error: { type: "overloaded_error", message: "synthetic overload" } }, { status: 503 })
    : new Response(wire(message([{ type: "text", text: "recovered", citations: null }])), { headers: { "content-type": "text/event-stream" } }) });
  const input: ResponseInputItem[] = [{ role: "user", content: "fixture" }], before = structuredClone(input);
  try {
    // When
    const response = native
      ? (await f.provider.nativeContext.respond({ runId: "fixture", input, tools: [], clock: "fixed", signal: new AbortController().signal })).response
      : await f.provider.respond(input, [], new AbortController().signal);
    // Then
    expect(response.output_text).toBe("recovered");
    expect(f.requests).toHaveLength(2); expect(f.requests[0]).toEqual(f.requests[1]); expect(input).toEqual(before);
  } finally { f.provider.close(); f.close(); }
});

test("Claude native capability lookup retries transient failure before caching supported capabilities", async () => {
  // Given
  let lookups = 0;
  const f = fixture({ capabilities: () => ++lookups === 1
    ? Response.json({ error: { type: "api_error", message: "synthetic" } }, { status: 503 })
    : Response.json({ id: "claude-opus-5-5", max_input_tokens: 200000, max_tokens: 32000, capabilities: { compaction: { supported: true, summarize: { supported: true } } } }) });
  try {
    // When
    const result = await f.provider.nativeContext.capability(new AbortController().signal);
    // Then
    expect(result.kind).toBe("supported"); expect(f.lookups()).toBe(2);
    expect((await f.provider.nativeContext.capability(new AbortController().signal)).kind).toBe("supported"); expect(f.lookups()).toBe(2);
  } finally { f.provider.close(); f.close(); }
});
