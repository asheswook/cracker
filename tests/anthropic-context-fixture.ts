import Anthropic from "@anthropic-ai/sdk";
import { z } from "zod";
import { AnthropicProvider } from "../packages/provider/anthropic.ts";
import type { ResponseInputItem, Tool } from "../packages/provider/index.ts";

export const model = "claude-opus-5-5";
export const fixtureTool = {
  type: "function",
  name: "shell",
  parameters: { type: "object", properties: {}, additionalProperties: false },
  strict: true,
} satisfies Tool;
export const Wire = z
  .object({
    model: z.string(),
    messages: z.array(z.object({ role: z.string(), content: z.unknown() }).catchall(z.unknown())),
    system: z.unknown().optional(),
    tools: z.unknown().optional(),
    compaction: z.unknown().optional(),
  })
  .catchall(z.unknown());
export type Wire = z.infer<typeof Wire>;
export const summaryBlock = {
  type: "compaction",
  content: "fixture signed summary",
  signature: "fixture-signature",
  encrypted_content: "fixture-opaque",
  future_metadata: { sequence: [1, 2] },
};
export function message(
  content: unknown[],
  stop_reason = "end_turn",
  id = "msg_fixture",
  responseModel = model,
) {
  return {
    id,
    type: "message",
    role: "assistant",
    model: responseModel,
    content,
    stop_reason,
    stop_sequence: null,
    stop_details: null,
    usage: {
      input_tokens: 70000,
      output_tokens: 5,
      cache_read_input_tokens: 0,
      cache_creation_input_tokens: 0,
    },
  };
}
export function wire(result: ReturnType<typeof message>, complete = true): string {
  const events: Record<string, unknown>[] = [
    { type: "message_start", message: { ...result, content: [], stop_reason: null } },
  ];
  for (const [index, raw] of result.content.entries()) {
    const block = z.object({ type: z.string() }).catchall(z.unknown()).parse(raw);
    if (block.type === "text") {
      events.push({ type: "content_block_start", index, content_block: { ...block, text: "" } });
      events.push({
        type: "content_block_delta",
        index,
        delta: { type: "text_delta", text: block["text"] },
      });
    } else events.push({ type: "content_block_start", index, content_block: block });
    events.push({ type: "content_block_stop", index });
  }
  events.push({
    type: "message_delta",
    delta: { stop_reason: result.stop_reason, stop_sequence: null },
    usage: result.usage,
  });
  if (complete) events.push({ type: "message_stop" });
  return events
    .map((event) => `event: ${event["type"]}\ndata: ${JSON.stringify(event)}\n\n`)
    .join("");
}
export function fixture(
  options: {
    readonly selectedModel?: string;
    readonly capabilities?: () => Response;
    readonly count?: (body: Wire, index: number) => number | Promise<number>;
    readonly respond?: (body: Wire, index: number) => Response | Promise<Response>;
  } = {},
) {
  const requests: Wire[] = [],
    counts: Wire[] = [],
    bodyBytes: {path:string;bytes:number}[] = [],
    headers: { beta: string | null; authPresent: boolean; path: string }[] = [];
  let lookups = 0;
  const server = Bun.serve({
    hostname: "127.0.0.1",
    port: 0,
    async fetch(request) {
      const path = new URL(request.url).pathname;
      headers.push({
        beta: request.headers.get("anthropic-beta"),
        authPresent: Boolean(request.headers.get("x-api-key")),
        path,
      });
      if (request.method === "GET") {
        lookups++;
        return (
          options.capabilities?.() ??
          Response.json({
            id: options.selectedModel ?? model,
            max_input_tokens: 200000,
            max_tokens: 32000,
            capabilities: { compaction: { supported: true, summarize: { supported: true } } },
          })
        );
      }
      const rawBody=await request.text();bodyBytes.push({path,bytes:Buffer.byteLength(rawBody,"utf8")});
      const body = Wire.parse(JSON.parse(rawBody));
      if (path.endsWith("/count_tokens")) {
        counts.push(body);
        return Response.json({
          input_tokens: (await options.count?.(body, counts.length)) ?? 90000,
        });
      }
      requests.push(body);
      return (
        options.respond?.(body, requests.length) ??
        new Response(
          wire(
            message(
              body.compaction ? [summaryBlock] : [{ type: "text", text: "done", citations: null }],
              body.compaction ? "compaction" : "end_turn",
            ),
          ),
          { headers: { "content-type": "text/event-stream" } },
        )
      );
    },
  });
  const makeProvider = () =>
    new AnthropicProvider(
      { model: options.selectedModel ?? model, apiKey: "fixture" },
      new Anthropic({ apiKey: "fixture", baseURL: server.url.href, maxRetries: 0 }),
    );
  return {
    server,
    requests,
    counts,
    bodyBytes,
    headers,
    makeProvider,
    provider: makeProvider(),
    lookups: () => lookups,
    close: () => server.stop(true),
  };
}
export function addReply(
  input: ResponseInputItem[],
  output: import("openai/resources/responses/responses").Response["output"],
): void {
  for (const item of output)
    if (item.type === "message" || item.type === "reasoning" || item.type === "function_call")
      input.push(item);
}
