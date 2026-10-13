import { expect, test } from "bun:test";
import { z } from "zod";
import { ErrorCode } from "@modelcontextprotocol/sdk/types.js";
import { mcpErrorFixture, parseCallFailure } from "./mcp-call-error-fixture.ts";

test("read-only MCP timeout returns a structured error after two attempts", async () => {
  // Given an actual SDK server returning JSON-RPC RequestTimeout over HTTP.
  const fixture = await mcpErrorFixture({ failure: { kind: "protocol", code: ErrorCode.RequestTimeout }, annotations: { readOnlyHint: true } });
  try {
    // When the public executor invokes the discovered remote tool.
    const result = await fixture.tools.run(fixture.lookup, "{}", new AbortController().signal);
    // Then the bounded retry becomes model-readable failure data.
    expect(parseCallFailure(result.text)).toMatchObject({ code: "timeout", attempts: 2, read_only: true, effect_uncertain: false, retryable: true, retry_safety: "read_only" });
    expect(fixture.attempts()).toBe(2);
  } finally { await fixture.close(); }
});

for (const annotations of [undefined, { readOnlyHint: false }, { readOnlyHint: true, destructiveHint: true }]) {
  test(`uncertain MCP effects are never automatically replayed: ${JSON.stringify(annotations)}`, async () => {
    // Given an unclassified, mutating, or explicitly destructive remote operation.
    const fixture = await mcpErrorFixture({ failure: { kind: "protocol", code: ErrorCode.RequestTimeout }, ...(annotations ? { annotations } : {}) });
    try {
      // When the remote reports a timeout after accepting the request.
      const result = await fixture.tools.run(fixture.lookup, "{}", new AbortController().signal);
      // Then callers receive uncertainty without a duplicate external attempt.
      expect(parseCallFailure(result.text)).toMatchObject({ code: "timeout", attempts: 1, read_only: false, effect_uncertain: true, retryable: false, retry_safety: "reconcile_before_retry" });
      expect(fixture.attempts()).toBe(1);
    } finally { await fixture.close(); }
  });
}

for (const sample of [
  { wire: ErrorCode.InvalidParams, code: "invalid_arguments" },
  { wire: ErrorCode.MethodNotFound, code: "tool_unavailable" },
]) test(`permanent protocol failure ${sample.code} is returned without retry`, async () => {
  // Given a read-only tool whose call is permanently rejected by the server.
  const fixture = await mcpErrorFixture({ failure: { kind: "protocol", code: sample.wire }, annotations: { readOnlyHint: true } });
  try {
    // When invoked through the actual HTTP MCP connection.
    const result = await fixture.tools.run(fixture.lookup, "{}", new AbortController().signal);
    // Then the permanent error consumes exactly one attempt.
    expect(parseCallFailure(result.text)).toMatchObject({ code: sample.code, attempts: 1, retryable: false });
    expect(fixture.attempts()).toBe(1);
  } finally { await fixture.close(); }
});

for (const sample of [
  { status: 401, code: "authentication_failed", attempts: 1, retryable: false },
  { status: 403, code: "access_denied", attempts: 1, retryable: false },
  { status: 429, code: "rate_limited", attempts: 2, retryable: true },
  { status: 503, code: "server_unavailable", attempts: 2, retryable: true },
]) test(`HTTP ${sample.status} becomes ${sample.code} with bounded attempts`, async () => {
  // Given a fault at the real MCP HTTP transport boundary after initialization.
  const fixture = await mcpErrorFixture({ failure: { kind: "http", status: sample.status }, annotations: { readOnlyHint: true } });
  try {
    // When the remote request receives the configured HTTP failure.
    const result = await fixture.tools.run(fixture.lookup, "{}", new AbortController().signal);
    // Then HTTP semantics determine classification and retry eligibility.
    expect(parseCallFailure(result.text)).toMatchObject({ code: sample.code, attempts: sample.attempts, retryable: sample.retryable });
    expect(fixture.attempts()).toBe(sample.attempts);
  } finally { await fixture.close(); }
});

test("transient read-only failure recovers on its single retry", async () => {
  // Given a timeout followed by a successful response from the same server.
  const fixture = await mcpErrorFixture({ failure: { kind: "protocol", code: ErrorCode.RequestTimeout }, annotations: { readOnlyHint: true }, failuresBeforeSuccess: 1 });
  try {
    // When the read-only operation is executed.
    const result = await fixture.tools.run(fixture.lookup, "{}", new AbortController().signal);
    // Then the caller receives the genuine successful retry result.
    expect(JSON.parse(result.text)).toEqual({ content: [{ type: "text", text: "recovered result" }] });
    expect(fixture.attempts()).toBe(2);
  } finally { await fixture.close(); }
});

test("normal remote isError result is preserved without retry", async () => {
  // Given a legitimate MCP tool-level error response rather than a thrown protocol error.
  const fixture = await mcpErrorFixture({ failure: { kind: "result" }, annotations: { readOnlyHint: true } });
  try {
    // When the executor receives the completed remote result.
    const result = await fixture.tools.run(fixture.lookup, "{}", new AbortController().signal);
    // Then the server's original structured result remains intact.
    expect(JSON.parse(result.text)).toEqual({ isError: true, content: [{ type: "text", text: "ordinary remote tool error" }] });
    expect(fixture.attempts()).toBe(1);
  } finally { await fixture.close(); }
});

test("parent cancellation rejects a pending MCP call instead of producing an error result", async () => {
  // Given a real MCP call held at an explicit server barrier.
  const fixture = await mcpErrorFixture({ failure: { kind: "held" }, annotations: { readOnlyHint: true } });
  const controller = new AbortController();
  try {
    const pending = fixture.tools.run(fixture.lookup, "{}", controller.signal);
    await fixture.entered.promise;
    // When the parent execution is cancelled.
    controller.abort(new DOMException("fixture parent cancellation", "AbortError"));
    // Then cancellation propagates and the tool is not retried.
    await expect(pending).rejects.toThrow("fixture parent cancellation");
    expect(fixture.attempts()).toBe(1);
  } finally { await fixture.close(); }
});

test("thrown MCP errors redact configured header and URL secrets", async () => {
  // Given synthetic fixture credentials echoed by an untrusted remote error.
  const secret = `fixture-secret-${crypto.randomUUID()}`;
  const urlSecret = `fixture-url-secret-${crypto.randomUUID()}`;
  const fixture = await mcpErrorFixture({ failure: { kind: "protocol", code: ErrorCode.InvalidParams, message: `Bad request with Bearer ${secret} and token=${urlSecret}` }, annotations: { readOnlyHint: true }, secret, urlSecret });
  try {
    // When the error is serialized for the model.
    const result = await fixture.tools.run(fixture.lookup, "{}", new AbortController().signal);
    // Then no configured secret survives the existing redaction boundary.
    expect(result.text).not.toContain(secret);
    expect(result.text).not.toContain(urlSecret);
    expect(parseCallFailure(result.text).code).toBe("invalid_arguments");
  } finally { await fixture.close(); }
});

test("transport errors preserve the offered catalogue until explicit MCP removal", async () => {
  // Given a connected tool catalogue used by an active model context.
  const fixture = await mcpErrorFixture({ failure: { kind: "http", status: 503 }, annotations: { readOnlyHint: true } });
  const offered = [...fixture.tools.definitions];
  try {
    // When a transport error marks the connection unhealthy.
    await fixture.tools.run(fixture.lookup, "{}", new AbortController().signal);
    // Then model definitions stay stable and unaffected tools remain usable.
    expect(fixture.tools.mcpStatus("fixture").connected).toBe(false);
    expect(fixture.tools.definitions).toEqual(offered);
    const followUp = await fixture.tools.run(fixture.healthy, "{}", new AbortController().signal);
    expect(JSON.parse(followUp.text)).toEqual({ content: [{ type: "text", text: "healthy result" }] });
    expect(fixture.healthyCalls()).toBe(1);
    await fixture.tools.removeMcp("fixture");
    expect(fixture.tools.definitions.some(tool => tool.type === "function" && tool.name === fixture.lookup)).toBe(false);
  } finally { await fixture.close(); }
});

test("closed MCP session reconnects before bounded retry while preserving the active tool catalogue", async () => {
  // Given a catalogue whose real server-side transport session is closed.
  const fixture = await mcpErrorFixture({ failure: { kind: "protocol", code: ErrorCode.RequestTimeout }, annotations: { readOnlyHint: true } });
  const offered = [...fixture.tools.definitions];
  try {
    await fixture.disconnect();
    // When the next tool request reaches the closed session.
    const result = await fixture.tools.run(fixture.lookup, "{}", new AbortController().signal);
    // Then the model receives failure data without changing its tool prefix.
    expect(parseCallFailure(result.text)).toMatchObject({ code: "timeout", attempts: 2, retryable: true });
    expect(fixture.tools.definitions).toEqual(offered);
    expect(fixture.attempts()).toBe(1);
    expect(fixture.tools.mcpStatus("fixture").connected).toBe(false);
  } finally { await fixture.close(); }
});

test("MCP error logs contain fixed diagnostics without remote messages or secrets", async () => {
  // Given an isolated real MCP client process with synthetic secret-bearing errors.
  const secret = `fixture-log-secret-${crypto.randomUUID()}`;
  const source = `import {mcpErrorFixture} from ${JSON.stringify(new URL("./mcp-call-error-fixture.ts", import.meta.url).href)};
    const secret=${JSON.stringify(secret)};
    const fixture=await mcpErrorFixture({failure:{kind:"protocol",code:-32602,message:"REMOTE_UNTRUSTED_MESSAGE "+secret},annotations:{readOnlyHint:true},secret});
    try { await fixture.tools.run(fixture.lookup,"{}",new AbortController().signal); } finally { await fixture.close(); }`;
  // When the public executor records the remote failure.
  const process = Bun.spawn([Bun.which("bun") ?? "bun", "-e", source], { stdout: "pipe", stderr: "pipe" });
  const stderr = await new Response(process.stderr).text();
  // Then diagnostics contain only bounded machine fields, never the remote message.
  expect(await process.exited).toBe(0);
  expect(stderr).not.toContain(secret);
  expect(stderr).not.toContain("REMOTE_UNTRUSTED_MESSAGE");
  const diagnostic = z.object({ event: z.literal("mcp.call.error"), code: z.literal("invalid_arguments"), attempt: z.number(), server: z.string(), tool_name: z.string(), duration_ms: z.number(), read_only: z.boolean(), rpc_code: z.number() }).strict();
  const records = stderr.trim().split("\n").map(line => diagnostic.parse(JSON.parse(line)));
  expect(records).toHaveLength(1);
  expect(records[0]).toMatchObject({ event: "mcp.call.error", code: "invalid_arguments", attempt: 1, server: "fixture" });
});

for (const sample of [
  { wire: ErrorCode.ConnectionClosed, code: "connection_closed", attempts: 2, retryable: true },
  { wire: -32123, code: "mcp_call_failed", attempts: 1, retryable: false },
]) test(`protocol failure ${sample.code} respects its retry bound`, async () => {
  // Given a protocol error that is either a known connection failure or an unknown code.
  const fixture = await mcpErrorFixture({ failure: { kind: "protocol", code: sample.wire }, annotations: { readOnlyHint: true } });
  try {
    // When the public executor handles the real JSON-RPC error response.
    const result = await fixture.tools.run(fixture.lookup, "{}", new AbortController().signal);
    // Then classification and retry bounds do not depend on remote error prose.
    expect(parseCallFailure(result.text)).toMatchObject({ code: sample.code, attempts: sample.attempts, retryable: sample.retryable });
    expect(fixture.attempts()).toBe(sample.attempts);
  } finally { await fixture.close(); }
});
