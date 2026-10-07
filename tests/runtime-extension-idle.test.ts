import { expect, spyOn, test } from "bun:test";
import { join } from "node:path";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { Observation } from "../packages/extensions/schema.ts";
import type { Assignment } from "../packages/protocol/index.ts";
import type { Provider } from "../packages/provider/index.ts";
import { Journal } from "../services/daemon/journal.ts";
import { Runtime } from "../services/daemon/runtime.ts";
import { ToolExecutor } from "../services/daemon/tools.ts";

test("stop preserves an existing disconnect fail-closed ownership decision", async () => {
  const journal = new Journal(":memory:"); journal.setControl("user");
  const server = Bun.serve({ port: 0, fetch: () => Response.json({ accepted: true }) });
  const runtime = new Runtime({ controlUrl: server.url.href, token: "fixture", journal, tools: new ToolExecutor(),
    provider: { respond: async () => { throw new TypeError("No provider during disconnect"); } } });
  try {
    await runtime.disconnect();
    expect(journal.control()).toBe("agent");
    await runtime.stop();
    expect(journal.control()).toBe("agent");
  } finally { journal.close(); await server.stop(true); }
});

test("graceful idle restart preserves persisted user ownership and releases inputs", async () => {
  const root = await mkdtemp(join(tmpdir(), "idle-owner-restart-")), path = join(root, "journal.sqlite");
  let releases = 0, barriers = 0, providerCalls = 0;
  const server = Bun.serve({ port: 0, fetch(request) {
    const route = new URL(request.url).pathname;
    if (route === "/v1/daemon/extensions") return Response.json({ skills: [], servers: [] });
    if (route === "/v1/daemon/poll") return Response.json({ assignment: null, commands: [], messages: [] });
    if (route === "/v1/daemon/events") return Response.json({ accepted: true });
    return new Response("Unexpected restart route", { status: 404 });
  } });
  const provider: Provider = { respond: async () => { providerCalls++; throw new TypeError("User-owned idle restart cannot run provider"); } };
  const original = new Journal(path); original.setControl("user");
  const first = new Runtime({ controlUrl: server.url.href, token: "fixture", journal: original, provider,
    tools: new ToolExecutor(), releaseInput: async () => { releases++; } });
  await first.stop(); original.close();
  const reopened = new Journal(path);
  const second = new Runtime({ controlUrl: server.url.href, token: "fixture", journal: reopened, provider,
    tools: new ToolExecutor(), inputBarrier: async () => { barriers++; } });
  try {
    expect(reopened.control()).toBe("user");
    await second.recover(); await second.tick();
    expect(reopened.control()).toBe("user"); expect(releases).toBe(1); expect(barriers).toBe(1); expect(providerCalls).toBe(0);
    console.log(JSON.stringify({ scenario: "idle-user-graceful-restart", persistedControl: reopened.control(), releases, barriers, providerCalls }));
  } finally { await second.stop(); reopened.close(); await server.stop(true); await rm(root, { recursive: true }); }
});

for (const available of [true, false]) test(`idle user ownership observes current MCP revision; available=${available}`, async () => {
  const now = new Date().toISOString();
  const observations: Array<ReturnType<typeof Observation.parse>> = [];
  let manifests = 0, polls = 0, providerCalls = 0;
  const extension = {
    id: crypto.randomUUID(), vm_id: crypto.randomUUID(), name: "Idle fixture", enabled: true,
    revision: 5, observed_revision: 4, state: "pending", tool_count: 0, error_code: null,
    observed_at: now, updated_at: now, secret_keys: [], secrets: {},
    config: { transport: "stdio", command: available ? process.execPath : "/nonexistent-idle-mcp-fixture",
      args: available ? [join(process.cwd(), "tests/mcp-extension-fixture.ts")] : [] },
  };
  const server = Bun.serve({ port: 0, async fetch(request) {
    switch (new URL(request.url).pathname) {
      case "/v1/daemon/extensions": manifests++; return Response.json({ skills: [], servers: [extension] });
      case "/v1/daemon/extensions/observed": observations.push(Observation.parse(await request.json())); return Response.json({ accepted: true });
      case "/v1/daemon/poll": polls++; return Response.json({ assignment: null, commands: [], messages: [] });
      case "/v1/daemon/events": return Response.json({ accepted: true });
      default: return new Response("Unexpected fixture route", { status: 404 });
    }
  } });
  const journal = new Journal(":memory:"); journal.setControl("user");
  const tools = new ToolExecutor();
  const runtime = new Runtime({ controlUrl: server.url.href, token: "fixture", journal, tools,
    provider: { respond: async () => { providerCalls++; throw new TypeError("Idle fixture must not execute provider"); } } });
  try {
    await runtime.tick();
    expect(manifests).toBe(1);
    expect(observations).toHaveLength(1);
    expect(observations[0]).toMatchObject({ id: extension.id, revision: 5, state: available ? "connected" : "error" });
    if (available) expect(observations[0]?.tool_count).toBeGreaterThan(0);
    else expect(observations[0]?.error_code).not.toBeNull();
    expect(journal.control()).toBe("user");
    expect(providerCalls).toBe(0); expect(polls).toBe(1);
    await runtime.tick();
    expect(manifests).toBe(1); expect(polls).toBe(2);
    expect(journal.control()).toBe("user");
    console.log(JSON.stringify({ scenario: "idle-user", available, manifests, polls,
      observedRevision: observations[0]?.revision, state: observations[0]?.state, providerCalls, control: journal.control() }));
  } finally { await runtime.stop(); journal.close(); await server.stop(true); }
});

test("active run retains its MCP catalog when a changed manifest is due", async () => {
  const now = new Date().toISOString(), started = Promise.withResolvers<void>();
  let assigned = false, manifests = 0, enabled = true, revision = 4;
  const work: Assignment = { run_id: crypto.randomUUID(), task: { id: crypto.randomUUID(), conversation_id: crypto.randomUUID(),
    objective: "hold fixture provider", state: "running", reason: null, created_at: now, updated_at: now }, messages: [], instructions: "", memory: [] };
  const extension = { id: crypto.randomUUID(), vm_id: crypto.randomUUID(), name: "Active fixture", observed_revision: 4,
    state: "connected", tool_count: 1, error_code: null, observed_at: now, updated_at: now, secret_keys: [], secrets: {},
    config: { transport: "stdio", command: process.execPath, args: [join(process.cwd(), "tests/mcp-extension-fixture.ts")] } };
  const server = Bun.serve({ port: 0, fetch(request) {
    const path = new URL(request.url).pathname;
    if (path === "/v1/daemon/extensions") { manifests++; return Response.json({ skills: [], servers: [{ ...extension, enabled, revision }] }); }
    if (path === "/v1/daemon/poll") { const assignment = assigned ? null : work; assigned = true; return Response.json({ assignment, commands: [], messages: [] }); }
    if (path.includes("/context")) return Response.json({ messages: [], instructions: "", memory: [] });
    return Response.json({ accepted: true, messages: [] });
  } });
  const provider: Provider = { respond: async (_input, _tools, signal) => {
    started.resolve();
    return new Promise((_resolve, reject) => signal.addEventListener("abort", () => reject(new DOMException("aborted", "AbortError")), { once: true }));
  } };
  const journal = new Journal(":memory:"), tools = new ToolExecutor();
  const runtime = new Runtime({ controlUrl: server.url.href, token: "fixture", journal, provider, tools });
  const clock = spyOn(Date, "now");
  try {
    await runtime.tick(); await started.promise;
    const names = tools.definitions.flatMap(tool => tool.type === "function" ? [tool.name] : []);
    expect(names.some(name => name.includes("fixture_echo"))).toBe(true);
    enabled = false; revision = 5;
    clock.mockReturnValue(Date.now() + 16_000);
    await runtime.tick();
    expect(manifests).toBe(1);
    expect(tools.definitions.flatMap(tool => tool.type === "function" ? [tool.name] : [])).toEqual(names);
    console.log(JSON.stringify({ scenario: "active-catalog", manifests, changedManifestRevision: revision, toolNamesUnchanged: true }));
  } finally { clock.mockRestore(); await runtime.stop(); journal.close(); await server.stop(true); }
});
