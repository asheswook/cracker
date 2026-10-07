import { mkdtemp, mkdir } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { z } from "zod";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { WebStandardStreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/webStandardStreamableHttp.js";
import { OpenAIProvider, type Provider } from "../packages/provider/index.ts";
import { DaemonEvent, type Assignment } from "../packages/protocol/index.ts";
import { Runtime } from "../services/daemon/runtime.ts";
import { Journal } from "../services/daemon/journal.ts";
import { ToolExecutor } from "../services/daemon/tools.ts";

const config = z
  .object({
    PROVIDER_MODE: z.enum(["chatgpt", "api"]),
    OPENAI_MODEL: z.string().min(1),
    OPENAI_REASONING_EFFORT: z.enum(["low", "medium", "high", "xhigh", "max"]).optional(),
    OPENAI_TRANSPORT: z.enum(["http", "websocket"]).default("http"),
    CHATGPT_TOKEN_FILE: z.string().optional(),
    OPENAI_API_KEY: z.string().optional(),
    QA_EVIDENCE_DIR: z.string().min(1),
  })
  .parse(process.env);
await mkdir(config.QA_EVIDENCE_DIR, { recursive: true });
const directory = await mkdtemp(join(tmpdir(), "assistant-parallel-live-"));
const raw = new OpenAIProvider({
  mode: config.PROVIDER_MODE,
  model: config.OPENAI_MODEL,
  transport: config.OPENAI_TRANSPORT,
  serviceTier: "default",
  ...(config.CHATGPT_TOKEN_FILE ? { tokenFile: config.CHATGPT_TOKEN_FILE } : {}),
  ...(config.OPENAI_API_KEY ? { apiKey: config.OPENAI_API_KEY } : {}),
  ...(config.OPENAI_REASONING_EFFORT ? { reasoningEffort: config.OPENAI_REASONING_EFFORT } : {}),
});
const usage: { lane: string; input: number; output: number; duration_ms: number }[] = [];
const inferenceActive = { lead: 0, child: 0 },
  inferencePeak = { lead: 0, child: 0 };
const provider: Provider = {
  standaloneCompaction: raw.standaloneCompaction,
  compact: (input, signal) => raw.compact(input, signal),
  respond: async (input, tools, signal, observer) => {
    const start = performance.now(),
      lane = tools.some((tool) => tool.type === "function" && tool.name === "spawn_agent")
        ? "lead"
        : "child";
    inferenceActive[lane]++;
    inferencePeak[lane] = Math.max(inferencePeak[lane], inferenceActive[lane]);
    try {
      const response = await raw.respond(input, tools, signal, observer);
      usage.push({
        lane,
        input: response.usage?.input_tokens ?? 0,
        output: response.usage?.output_tokens ?? 0,
        duration_ms: Math.round(performance.now() - start),
      });
      return response;
    } finally {
      inferenceActive[lane]--;
    }
  },
};
const topics = ["alpha", "beta", "gamma", "delta"] as const;
const facts = Object.fromEntries(
  topics.map((topic) => [topic, `${topic}-${crypto.randomUUID().slice(0, 8)}`]),
);
const active = { lead: 0, child: 0 },
  peak = { lead: 0, child: 0 },
  requests: string[] = [];
const mcp = new McpServer({ name: "synthetic-sources", version: "1" });
mcp.registerTool(
  "read_source",
  {
    description: "Read one synthetic source by name and return its exact verification code.",
    annotations: { readOnlyHint: true },
    inputSchema: { topic: z.enum(topics) },
  },
  async ({ topic }) => {
    const lane = topic === "gamma" || topic === "delta" ? "lead" : "child";
    active[lane]++;
    peak[lane] = Math.max(peak[lane], active[lane]);
    requests.push(topic);
    try {
      await new Promise((resolve) => setTimeout(resolve, 300));
      return {
        content: [
          {
            type: "text",
            text: JSON.stringify({ source: topic, verification_code: facts[topic] }),
          },
        ],
      };
    } finally {
      active[lane]--;
    }
  },
);
const transport = new WebStandardStreamableHTTPServerTransport({
  sessionIdGenerator: () => crypto.randomUUID(),
  enableJsonResponse: true,
});
await mcp.connect(transport);
const sourceServer = Bun.serve({
  hostname: "127.0.0.1",
  port: 0,
  fetch: (request) => transport.handleRequest(request),
});
const tools = new ToolExecutor();
tools.definitions.splice(0);
await tools.addMcp("synthetic", { transport: "http", url: sourceServer.url.href }, {});
const run = crypto.randomUUID(),
  conversation = crypto.randomUUID(),
  now = new Date().toISOString();
const assignment: Assignment = {
  run_id: run,
  task: {
    id: crypto.randomUUID(),
    conversation_id: conversation,
    objective: "Parallel source verification",
    state: "running",
    reason: null,
    created_at: now,
    updated_at: now,
  },
  instructions:
    "This is an isolated verification task. Use only synthetic read_source and agent delegation tools. Do not use filesystem, desktop, scheduling, artifacts, memory retrieval or external services. Children must also use only read_source.",
  memory: [],
  messages: [
    {
      id: crypto.randomUUID(),
      conversation_id: conversation,
      role: "user",
      sequence: 1,
      client_message_id: null,
      created_at: now,
      content:
        "Spawn two independent agents: one reads source alpha and reports its exact verification_code; the other reads beta and reports its exact verification_code. While they work, you must call read_source for gamma and delta together in one response. Read both child results. Then give one final answer containing all four exact codes, with each source name. Do not guess codes; each exists only in the tool response.",
    },
  ],
};
const events: DaemonEvent[] = [],
  done = Promise.withResolvers<void>();
let assigned = false;
const control = Bun.serve({
  hostname: "127.0.0.1",
  port: 0,
  async fetch(request) {
    const path = new URL(request.url).pathname;
    if (path === "/v1/daemon/extensions") return Response.json({ skills: [], servers: [] });
    if (path === "/v1/daemon/poll") {
      const next = assigned ? null : assignment;
      assigned = true;
      return Response.json({ assignment: next, commands: [], messages: [] });
    }
    if (path === "/v1/daemon/events") {
      const event = DaemonEvent.parse(await request.json());
      events.push(event);
      if (event.kind === "state") done.resolve();
      return Response.json({ accepted: true });
    }
    if (path === "/v1/daemon/composing") return new Response(null, { status: 404 });
    if (path === `/v1/daemon/context/${run}`) return Response.json({ messages: [] });
    return new Response(null, { status: 404 });
  },
});
const journal = new Journal(join(directory, "journal.sqlite"));
const failures: unknown[] = [];
const runtime = new Runtime({
  controlUrl: control.url.href,
  token: "isolated-fixture-only",
  provider,
  tools,
  journal,
  artifactRoot: directory,
  onFailure: (event) => failures.push(event),
});
let timer: ReturnType<typeof setTimeout> | undefined;
let passed = false;
try {
  const start = performance.now();
  await runtime.tick();
  await Promise.race([
    done.promise,
    new Promise<never>((_resolve, reject) => {
      timer = setTimeout(() => reject(new Error("live_harness_deadline")), 180000);
    }),
  ]);
  const children = journal.children.list(run),
    messages = events.flatMap((event) => (event.kind === "message" ? [event.content] : [])),
    final = messages.join("\n");
  const checks = {
    succeeded: events.some((event) => event.kind === "state" && event.state === "succeeded"),
    lead_overlap: peak.lead >= 2,
    child_inference_overlap: inferencePeak.child >= 2,
    two_children: children.length === 2,
    children_completed: children.every((child) => child.state === "succeeded" && child.consumed),
    child_source_codes: ["alpha", "beta"].every((topic) =>
      children.some((child) => child.result?.includes(facts[topic] ?? "missing")),
    ),
    all_codes: topics.every((topic) => final.includes(facts[topic] ?? "missing")),
    all_sources_read: topics.every((topic) => requests.includes(topic)),
    no_runtime_failure: failures.length === 0,
  };
  passed = Object.values(checks).every(Boolean);
  const receipt = {
    passed,
    checks,
    model: config.OPENAI_MODEL,
    provider: config.PROVIDER_MODE,
    reasoning: config.OPENAI_REASONING_EFFORT ?? null,
    transport: config.OPENAI_TRANSPORT,
    service_tier: "default",
    duration_ms: Math.round(performance.now() - start),
    synthetic_source_delay_ms: 300,
    peak,
    inferencePeak,
    requests,
    children: children.map((child) => ({
      id: child.id,
      state: child.state,
      consumed: child.consumed,
    })),
    usage,
    messages,
    failures,
    local_journal: join(directory, "journal.sqlite"),
  };
  await Bun.write(
    join(config.QA_EVIDENCE_DIR, "live-model.json"),
    JSON.stringify(receipt, null, 2),
  );
  console.log(JSON.stringify({ passed, checks, peak, model: config.OPENAI_MODEL }));
} finally {
  clearTimeout(timer);
  await runtime.stop();
  await raw.close();
  await mcp.close();
  await sourceServer.stop(true);
  await control.stop(true);
  journal.close();
}
if (!passed) process.exitCode = 1;
