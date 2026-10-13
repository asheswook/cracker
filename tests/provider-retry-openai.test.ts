import { expect, test } from "bun:test";
import OpenAI from "openai";
import { OpenAIProvider } from "../packages/provider/index.ts";

for (const mode of ["transient", "persistent", "unauthorized", "truncated"] as const) test(`OpenAI ${mode} HTTP inference retries only the request with SDK retries disabled`, async () => {
  // Given a loopback SDK client configured with retries to prove the adapter overrides multiplication.
  const bodies: string[] = [];
  const server = Bun.serve({ hostname: "127.0.0.1", port: 0, async fetch(request) {
    bodies.push(await request.text());
    if (mode === "persistent" || mode === "unauthorized" || (mode === "transient" && bodies.length === 1))
      return Response.json({ error: { message: "synthetic", type: "server_error" } }, { status: mode === "unauthorized" ? 401 : 503 });
    if (mode === "truncated" && bodies.length === 1) return new Response("data: [DONE]\n\n", { headers: { "content-type": "text/event-stream" } });
    return new Response(`data: ${JSON.stringify({ type: "response.completed", response: { id: "resp_fixture", output: [{ type: "message", id: "msg_fixture", role: "assistant", status: "completed", content: [{ type: "output_text", text: "recovered", annotations: [] }] }] } })}\n\n`, { headers: { "content-type": "text/event-stream" } });
  } });
  const provider = new OpenAIProvider({ mode: "api", model: "fixture", apiKey: "fixture" }, new OpenAI({ apiKey: "fixture", baseURL: server.url.href, maxRetries: 9 }));
  try {
    // When
    const result = provider.respond([{ role: "user", content: "fixture" }], [], new AbortController().signal);
    // Then
    if (mode === "persistent" || mode === "unauthorized") await expect(result).rejects.toBeInstanceOf(OpenAI.APIError);
    else expect((await result).output_text).toBe("recovered");
    expect(bodies).toHaveLength(mode === "persistent" ? 3 : mode === "unauthorized" ? 1 : 2);
    expect(new Set(bodies).size).toBe(1);
  } finally { provider.close(); server.stop(true); }
});

for (const frame of ["named_error", "data_error"] as const) test(`HTTP200 SSE ${frame} retries a status-less SDK error and preserves the request`, async () => {
  // Given a real SDK stream with a transient error after successful HTTP headers.
  const bodies: string[] = [];
  const server = Bun.serve({ hostname: "127.0.0.1", port: 0, async fetch(request) {
    bodies.push(await request.text());
    const error = { code: "server_error", type: "server_error", message: "fixture transient failure" };
    const failure = frame === "named_error" ? `event: error\ndata: ${JSON.stringify({ error })}\n\n` : `data: ${JSON.stringify({ error })}\n\n`;
    const complete = `data: ${JSON.stringify({ type: "response.completed", response: { id: "resp_recovered", output: [{ type: "message", id: "msg_recovered", role: "assistant", status: "completed", content: [{ type: "output_text", text: "stream recovered", annotations: [] }] }] } })}\n\n`;
    return new Response(bodies.length === 1 ? failure : complete, { headers: { "content-type": "text/event-stream" } });
  } });
  const provider = new OpenAIProvider({ mode: "api", model: "fixture", apiKey: "fixture" }, new OpenAI({ apiKey: "fixture", baseURL: server.url.href, maxRetries: 9 }));
  try {
    // When the provider consumes the error frame through the actual OpenAI SDK.
    const result = await provider.respond([{ role: "user", content: "fixture" }], [], new AbortController().signal);
    // Then only inference is retried using the same request body.
    expect(result.output_text).toBe("stream recovered");
    expect(bodies).toHaveLength(2);
    expect(bodies[0]).toBe(bodies[1]);
  } finally { provider.close(); await server.stop(true); }
});

for (const event of ["response.failed", "response.incomplete", "error"] as const) test(`HTTP200 ${event} preserves transient failure metadata for retry`, async () => {
  // Given a terminal Responses event that carries a server error instead of an HTTP failure.
  const bodies: string[] = [];
  const server = Bun.serve({ hostname: "127.0.0.1", port: 0, async fetch(request) {
    bodies.push(await request.text());
    const error = { code: "server_error", type: "server_error", message: "fixture" };
    const failure = event === "error" ? { ...error, type: event, sequence_number: 1 } : { type: event, response: { id: "resp_failed", output: [], status: event === "response.failed" ? "failed" : "incomplete", error } };
    const complete = { type: "response.completed", response: { id: "resp_recovered", output: [{ type: "message", id: "msg_recovered", role: "assistant", status: "completed", content: [{ type: "output_text", text: "terminal recovered", annotations: [] }] }] } };
    return new Response(`data: ${JSON.stringify(bodies.length === 1 ? failure : complete)}\n\n`, { headers: { "content-type": "text/event-stream" } });
  } });
  const provider = new OpenAIProvider({ mode: "api", model: "fixture", apiKey: "fixture" }, new OpenAI({ apiKey: "fixture", baseURL: server.url.href, maxRetries: 9 }));
  try {
    // When the real SDK and stream consumer decode the terminal failure.
    const result = await provider.respond([{ role: "user", content: "fixture" }], [], new AbortController().signal);
    // Then the preserved discriminator enables one retry with unchanged ancestry.
    expect(result.output_text).toBe("terminal recovered");
    expect(bodies).toHaveLength(2);
    expect(bodies[0]).toBe(bodies[1]);
  } finally { provider.close(); await server.stop(true); }
});

for (const reason of ["max_output_tokens", "content_filter"] as const) test(`response.incomplete ${reason} never retries the same limited request`, async () => {
  // Given a stream whose completion reason requires a changed request or user decision.
  let attempts = 0;
  const server = Bun.serve({ hostname: "127.0.0.1", port: 0, fetch() {
    attempts++;
    return new Response(`data: ${JSON.stringify({ type: "response.incomplete", response: { id: "resp_incomplete", output: [], status: "incomplete", error: { code: "server_error", message: "fixture" }, incomplete_details: { reason } } })}\n\n`, { headers: { "content-type": "text/event-stream" } });
  } });
  const provider = new OpenAIProvider({ mode: "api", model: "fixture", apiKey: "fixture" }, new OpenAI({ apiKey: "fixture", baseURL: server.url.href, maxRetries: 9 }));
  try {
    // When consuming the incomplete response with contradictory transient metadata.
    await expect(provider.respond([{ role: "user", content: "fixture" }], [], new AbortController().signal)).rejects.toThrow();
    // Then the known permanent incomplete reason takes precedence.
    expect(attempts).toBe(1);
  } finally { provider.close(); await server.stop(true); }
});

test("persistent unknown status-less SSE errors stop after exactly three identical requests", async () => {
  // Given SDK retries set high and an unclassified error on every HTTP200 stream.
  const bodies: string[] = [];
  const server = Bun.serve({ hostname: "127.0.0.1", port: 0, async fetch(request) {
    bodies.push(await request.text());
    return new Response(`data: ${JSON.stringify({ error: { code: "new_wire_failure", type: "new_wire_type", message: "fixture" } })}\n\n`, { headers: { "content-type": "text/event-stream" } });
  } });
  const provider = new OpenAIProvider({ mode: "api", model: "fixture", apiKey: "fixture" }, new OpenAI({ apiKey: "fixture", baseURL: server.url.href, maxRetries: 9 }));
  try {
    // When the provider exhausts its bounded retry policy.
    await expect(provider.respond([{ role: "user", content: "fixture" }], [], new AbortController().signal)).rejects.toBeInstanceOf(OpenAI.APIError);
    // Then SDK retries cannot multiply the three-attempt inference limit.
    expect(bodies).toHaveLength(3);
    expect(new Set(bodies).size).toBe(1);
  } finally { provider.close(); await server.stop(true); }
});

for (const code of ["invalid_api_key", "insufficient_quota", "unsupported_parameter"]) test(`HTTP200 SSE permanent ${code} is not retried by either SDK or adapter`, async () => {
  // Given a permanent provider error arriving inside an otherwise successful HTTP stream.
  let attempts = 0;
  const server = Bun.serve({ hostname: "127.0.0.1", port: 0, fetch() {
    attempts++;
    return new Response(`event: error\ndata: ${JSON.stringify({ error: { code, type: "server_error", message: "fixture permanent rejection" } })}\n\n`, { headers: { "content-type": "text/event-stream" } });
  } });
  const provider = new OpenAIProvider({ mode: "api", model: "fixture", apiKey: "fixture" }, new OpenAI({ apiKey: "fixture", baseURL: server.url.href, maxRetries: 9 }));
  try {
    // When the SDK constructs a status-less APIError from the actual frame.
    await expect(provider.respond([{ role: "user", content: "fixture" }], [], new AbortController().signal)).rejects.toBeInstanceOf(OpenAI.APIError);
    // Then the permanent code defeats the contradictory transient type.
    expect(attempts).toBe(1);
  } finally { provider.close(); await server.stop(true); }
});
