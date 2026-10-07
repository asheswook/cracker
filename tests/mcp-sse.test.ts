import { expect, test } from "bun:test";
import { z } from "zod";
import { ToolExecutor } from "../services/daemon/tools.ts";
import { mcpConnectionFailure } from "../services/daemon/mcp-failure.ts";

for (const fallbackStatus of [400, 404, 405]) test(`HTTP MCP falls back to legacy SSE with signed query and no extra header after ${fallbackStatus}`, async () => {
  let stream: ReadableStreamDefaultController<Uint8Array> | undefined;
  const requests: { method: string; path: string; token: string | null; auth: string | null }[] = [];
  const encoder = new TextEncoder();
  const server = Bun.serve({ port: 0, async fetch(request) {
    const url = new URL(request.url);
    requests.push({ method: request.method, path: url.pathname, token: url.searchParams.get("token"), auth: request.headers.get("authorization") });
    if (url.pathname === "/sse" && url.searchParams.get("token") !== "synthetic-query-token") return new Response("unauthorized", { status: 401 });
    if (url.pathname === "/sse" && request.method === "POST") return new Response("legacy endpoint", { status: fallbackStatus });
    if (url.pathname === "/sse") return new Response(new ReadableStream<Uint8Array>({ start(controller) {
      stream = controller; controller.enqueue(encoder.encode("event: endpoint\ndata: /messages?token=synthetic-query-token\n\n"));
    } }), { headers: { "content-type": "text/event-stream" } });
    const message = z.object({ id: z.union([z.string(), z.number()]).optional(), method: z.string() }).parse(await request.json());
    const result = message.method === "initialize" ? { protocolVersion: "2024-11-05", capabilities: { tools: {} }, serverInfo: { name: "fixture", version: "1" } } : { tools: [{ name: "fixture_read", inputSchema: { type: "object", properties: {} } }] };
    if (message.id !== undefined) stream?.enqueue(encoder.encode(`event: message\ndata: ${JSON.stringify({ jsonrpc: "2.0", id: message.id, result })}\n\n`));
    return new Response(null, { status: 202 });
  } });
  const tools = new ToolExecutor();
  try {
    expect(await tools.addMcp("legacy", { transport: "http", url: new URL("/sse?token=synthetic-query-token", server.url).href }, {})).toBe(1);
    expect(tools.mcpStatus("legacy")).toEqual({ connected: true, tool_count: 1 });
    expect(requests.slice(0, 2).map(item => item.method)).toEqual(["POST", "GET"]);
    expect(requests.every(item => item.token === "synthetic-query-token" && item.auth === null)).toBe(true);
    await tools.removeMcp("legacy");
    expect(tools.mcpStatus("legacy")).toEqual({ connected: false, tool_count: 0 });
  } finally { await tools.close(); await server.stop(true); }
});

for (const [status, failure] of [[401, "authentication_failed"], [403, "access_denied"], [429, "rate_limited"], [500, "server_unavailable"]] as const) test(`HTTP MCP classifies ${status} without retrying as SSE`, async () => {
  const methods: string[] = [];
  const server = Bun.serve({ port: 0, fetch(request) { methods.push(request.method); return new Response("unavailable", { status }); } });
  const tools = new ToolExecutor();
  try {
    const result = await tools.addMcp("failure", { transport: "http", url: server.url.href }, {}).catch(error => error);
    expect(result).toBeInstanceOf(Error);
    if (!(result instanceof Error)) throw new TypeError("Expected a connection error");
    expect(mcpConnectionFailure(result)).toBe(failure);
    expect(methods).toEqual(["POST"]);
    expect(tools.mcpStatus("failure")).toEqual({ connected: false, tool_count: 0 });
  } finally { await tools.close(); await server.stop(true); }
});

for (const [status, failure] of [[401, "authentication_failed"], [403, "access_denied"], [404, "endpoint_not_found"], [503, "server_unavailable"]] as const) test(`legacy SSE classifies its final ${status} failure`, async () => {
  const methods: string[] = [];
  const server = Bun.serve({ port: 0, fetch(request) { methods.push(request.method); return new Response("synthetic-private-error", { status: request.method === "POST" ? 405 : status }); } });
  const tools = new ToolExecutor();
  try {
    const result = await tools.addMcp("failure", { transport: "http", url: server.url.href }, {}).catch(error => error);
    expect(result).toBeInstanceOf(Error);
    if (!(result instanceof Error)) throw new TypeError("Expected a connection error");
    expect(mcpConnectionFailure(result)).toBe(failure);
    expect(methods).toEqual(["POST", "GET"]);
  } finally { await tools.close(); await server.stop(true); }
});

test("MCP error text is not interpreted as a trusted status or copied into observations", () => {
  expect(mcpConnectionFailure(new Error("https://fixture.test?token=private 401"))).toBe("connect_failed");
});

test("legacy SSE startup without an endpoint times out and removes the connection", async () => {
  const server = Bun.serve({ port: 0, fetch(request) {
    if (request.method === "POST") return new Response(null, { status: 404 });
    return new Response(new ReadableStream<Uint8Array>({ start(controller) { controller.enqueue(new TextEncoder().encode(": keepalive\n\n")); } }), { headers: { "content-type": "text/event-stream" } });
  } });
  const tools = new ToolExecutor();
  const start = performance.now();
  try {
    const result = await tools.addMcp("stalled", { transport: "http", url: server.url.href }, {}).catch(error => error);
    expect(result).toBeInstanceOf(Error);
    if (!(result instanceof Error)) throw new TypeError("Expected a timeout error");
    expect(mcpConnectionFailure(result)).toBe("connection_timeout");
    expect(performance.now() - start).toBeLessThan(11000);
    expect(tools.mcpStatus("stalled")).toEqual({ connected: false, tool_count: 0 });
  } finally { await tools.close(); await server.stop(true); }
}, 15000);
