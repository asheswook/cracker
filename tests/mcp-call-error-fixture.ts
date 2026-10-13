import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { WebStandardStreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/webStandardStreamableHttp.js";
import { CallToolRequestSchema, ListToolsRequestSchema, McpError } from "@modelcontextprotocol/sdk/types.js";
import { z } from "zod";
import { ToolExecutor } from "../services/daemon/tools.ts";

type Failure =
  | { readonly kind: "protocol"; readonly code: number; readonly message?: string }
  | { readonly kind: "http"; readonly status: number }
  | { readonly kind: "result" }
  | { readonly kind: "held" };
type FixtureOptions = {
  readonly failure: Failure;
  readonly annotations?: { readonly readOnlyHint?: boolean; readonly destructiveHint?: boolean };
  readonly failuresBeforeSuccess?: number;
  readonly secret?: string;
  readonly urlSecret?: string;
};
export const errorEnvelope = z.object({ isError: z.literal(true), content: z.array(z.object({ type: z.literal("text"), text: z.string() })) });
export const callFailure = z.object({ kind: z.literal("mcp_call_error"), code: z.string(), message: z.string(), attempts: z.number(), read_only: z.boolean(), effect_uncertain: z.boolean(), retryable: z.boolean(), retry_safety: z.enum(["read_only", "reconcile_before_retry"]) });
export function parseCallFailure(text: string) {
  const envelope = errorEnvelope.parse(JSON.parse(text));
  const content = envelope.content[0];
  if (!content) throw new TypeError("Missing MCP error content");
  return callFailure.parse(JSON.parse(content.text));
}
export async function mcpErrorFixture(options: FixtureOptions) {
  const entered = Promise.withResolvers<void>(), release = Promise.withResolvers<void>();
  let attempts = 0, healthyCalls = 0;
  const sessions: {server:Server;transport:WebStandardStreamableHTTPServerTransport}[]=[];
  async function createSession(){
  const server = new Server({ name: "error-fixture", version: "1" }, { capabilities: { tools: {} } });
  server.setRequestHandler(ListToolsRequestSchema, async () => ({ tools: [
    { name: "lookup", inputSchema: { type: "object", properties: {}, additionalProperties: false }, ...(options.annotations ? { annotations: options.annotations } : {}) },
    { name: "healthy", inputSchema: { type: "object", properties: {}, additionalProperties: false }, annotations: { readOnlyHint: true } },
  ] }));
  server.setRequestHandler(CallToolRequestSchema, async request => {
    if (request.params.name === "healthy") { healthyCalls++; return { content: [{ type: "text", text: "healthy result" }] }; }
    attempts++;
    entered.resolve();
    if (attempts > (options.failuresBeforeSuccess ?? Infinity)) return { content: [{ type: "text", text: "recovered result" }] };
    switch (options.failure.kind) {
      case "protocol": throw new McpError(options.failure.code, options.failure.message ?? "fixture remote failure");
      case "result": return { isError: true, content: [{ type: "text", text: "ordinary remote tool error" }] };
      case "held": await release.promise; return { content: [{ type: "text", text: "released result" }] };
      case "http": throw new TypeError("HTTP fault must be intercepted by fixture transport");
    }
  });
  const transport = new WebStandardStreamableHTTPServerTransport({ sessionIdGenerator: () => crypto.randomUUID(), enableJsonResponse: true });
  await server.connect(transport);
  const item={server,transport};sessions.push(item);return item;
  }
  const http = Bun.serve({ port: 0, async fetch(request) {
    if (options.failure.kind === "http" && request.method === "POST") {
      const payload: unknown = await request.clone().json();
      const call = z.object({ method: z.literal("tools/call"), params: z.object({ name: z.literal("lookup") }) }).safeParse(payload);
      if (call.success) { attempts++; entered.resolve(); return new Response("fixture transport failure", { status: options.failure.status }); }
    }
    const sessionId=request.headers.get('mcp-session-id');
    let session=sessions.find(item=>item.transport.sessionId===sessionId);
    if(!sessionId&&request.method==='POST')session=await createSession();
    return session?session.transport.handleRequest(request):new Response('Session expired',{status:404});
  } });
  const tools = new ToolExecutor();
  const url = new URL(http.url);
  if (options.urlSecret ?? options.secret) url.searchParams.set("token", options.urlSecret ?? options.secret ?? "");
  await tools.addMcp("fixture", { transport: "http", url: url.href }, options.secret ? { Authorization: `Bearer ${options.secret}`, "X-API-Key": options.secret } : {});
  const names = tools.definitions.flatMap(tool => tool.type === "function" ? [tool.name] : []);
  const lookup = names.find(name => name.startsWith("mcp_fixture_lookup_"));
  const healthy = names.find(name => name.startsWith("mcp_fixture_healthy_"));
  if (!lookup || !healthy) throw new TypeError("Fixture tools were not discovered");
  return { tools, lookup, healthy, entered, release, attempts: () => attempts, healthyCalls: () => healthyCalls,
    async disconnect() { for(const item of sessions)await item.transport.close();sessions.length=0; },
    async close() { release.resolve(); await http.stop(true); await tools.close(); await Promise.all(sessions.map(item=>item.server.close())); },
  };
}
