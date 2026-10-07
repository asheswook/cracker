import { expect, test } from "bun:test";
import { z } from "zod";
import { createApp } from "../services/control/app.ts";
import { Assignment, DaemonPoll } from "../packages/protocol/index.ts";
import { ModelAccess, ModelSettings, type ModelSelection } from "../packages/models/schema.ts";
import { controlFixture } from "./control-fixture.ts";

const f = controlFixture();
const app = createApp(f.sql, { extensionKey: Buffer.alloc(32, 7).toString("base64") });
const original: ModelSelection = { provider: "chatgpt", model: "gpt-6-astra", reasoning_effort: "low" };
const claude: ModelSelection = { provider: "anthropic", model: "claude-sonnet-5-5", reasoning_effort: null };
const route = `/v1/model-settings?vm_id=${f.vm}`;
function request(path: string, options: { readonly token?: string; readonly body?: unknown; readonly method?: string } = {}) {
  return app.request(path, { method: options.method ?? (options.body ? "POST" : "GET"), headers: { authorization: `Bearer ${options.token ?? f.client}`, "content-type": "application/json" }, ...(options.body ? { body: JSON.stringify(options.body) } : {}) });
}
async function settings() {
  const response = await request(route), body: unknown = await response.json();
  expect(response.status).toBe(200);
  return ModelSettings.parse(body);
}
async function save(selection: ModelSelection, key?: string) {
  const before = await settings();
  return request("/v1/model-settings", { method: "PUT", body: { vm_id: f.vm, expected_revision_id: before.binding?.revision_id ?? null, selection, ...(key ? { api_key: key } : {}) } });
}
async function start() {
  await f.newTask();
  const poll = DaemonPoll.parse(await (await request("/v1/daemon/poll?view=work", { token: f.machine })).json());
  if (!poll.assignment) throw new TypeError("Expected assignment");
  return poll.assignment;
}
test("an older run without model metadata keeps the legacy binding when settings are later introduced", async () => {
  const run = await start();
  expect(run.model_binding).toBeUndefined();
  expect((await request("/v1/daemon/model-settings/defaults", { token: f.machine, body: { selection: original, available: ["chatgpt"] } })).status).toBe(200);
  expect((await settings()).binding).toEqual({ revision_id: null, selection: original });
  expect(ModelAccess.parse(await (await request(`/v1/daemon/model-settings/runs/${run.run_id}`, { token: f.machine })).json())).toEqual({ binding: null, api_key: null });
  await f.finishActive();
});
test("default selection and saved credentials are immutable for a run across edits and resume", async () => {
  const defaultRun = await start();
  expect(defaultRun.model_binding?.selection).toEqual(original);
  const saved = await save(claude, "test-only-claude-key-one");
  expect(saved.status).toBe(200);
  const publicText = await saved.text();
  expect(publicText).not.toContain("test-only-claude-key");
  expect(publicText).not.toContain("secret_cipher");
  const profile = ModelSettings.parse(JSON.parse(publicText));
  expect(profile.saved_credentials).toContain("anthropic");
  const resumed = z.object({ assignment: Assignment }).parse(await (await request(`/v1/daemon/resume/${defaultRun.run_id}`, { token: f.machine, body: {} })).json());
  expect(resumed.assignment.model_binding).toEqual(defaultRun.model_binding);
  await f.finishActive();
  const selectedRun = await start();
  expect(selectedRun.model_binding).toEqual(profile.binding ?? undefined);
  expect(JSON.stringify(selectedRun)).not.toContain("test-only-claude-key");
  const accessPath = `/v1/daemon/model-settings/runs/${selectedRun.run_id}`;
  const before = ModelAccess.parse(await (await request(accessPath, { token: f.machine })).json());
  expect(before.api_key).toBe("test-only-claude-key-one");
  expect((await save({ ...claude, model: "claude-opus-5-5" }, "test-only-claude-key-two")).status).toBe(200);
  expect(ModelAccess.parse(await (await request(accessPath, { token: f.machine })).json())).toEqual(before);
  const current = ModelAccess.parse(await (await request("/v1/daemon/model-settings/current", { token: f.machine })).json());
  expect(current.api_key).toBe("test-only-claude-key-two");
  expect(current.binding?.selection.model).toBe("claude-opus-5-5");
  const raw = JSON.stringify(await f.sql`SELECT secret_cipher FROM assistant.model_revisions WHERE vm_id=${f.vm}`);
  expect(raw).not.toContain("test-only-claude-key");
  expect((await request(accessPath)).status).toBe(403);
  const alienVm = crypto.randomUUID(), alienMachine = crypto.randomUUID();
  const { hashToken } = await import("../services/control/auth.ts");
  await f.sql`INSERT INTO assistant.vms(id,workspace_id,name) VALUES(${alienVm},${f.alien},'other')`;
  await f.sql`INSERT INTO assistant.credentials(token_hash,workspace_id,role,vm_id) VALUES(${await hashToken(alienMachine)},${f.alien},'vm',${alienVm})`;
  expect((await request(accessPath, { token: alienMachine })).status).toBe(404);
  expect((await request(route, { token: f.alienToken })).status).toBe(404);
  expect((await request(route)).headers.get("cache-control")).toBe("no-store");
  await f.finishActive();
});
test("saving a model retains its provider key, rejects stale writes, and never selects paid API as a fallback", async () => {
  expect((await save({ provider: "openai", model: "gpt-6-astra", reasoning_effort: "low" })).status).toBe(409);
  expect((await save({ ...claude, model: "claude-sonnet-5-5" })).status).toBe(200);
  const selected = await settings();
  const body = { vm_id: f.vm, expected_revision_id: selected.binding?.revision_id, selection: original };
  const responses = await Promise.all([request("/v1/model-settings", { method: "PUT", body }), request("/v1/model-settings", { method: "PUT", body })]);
  expect(responses.map(response => response.status).sort()).toEqual([200, 409]);
  const chosen = await settings();
  expect(chosen.binding?.selection).toEqual(original);
  expect((await save(original, "test-only-unwanted-key")).status).toBe(400);
  expect((await save({ provider: "anthropic", model: "gpt-6-astra", reasoning_effort: null })).status).toBe(400);
  expect((await save({ ...claude, reasoning_effort: "low" })).status).toBe(400);
});
