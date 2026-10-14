import { expect, test } from "bun:test";
import { z } from "zod";
import { createApp } from "../services/control/app.ts";
import { SubscriptionClaim, SubscriptionReply } from "../packages/models/subscription-schema.ts";
import { controlFixture } from "./control-fixture.ts";

const f = controlFixture();
const app = createApp(f.sql, { extensionKey: Buffer.alloc(32, 7).toString("base64") });
const call = (path: string, token: string, body?: unknown) => app.request(path, { method: body ? "POST" : "GET", headers: { authorization: `Bearer ${token}`, "content-type": "application/json" }, ...(body ? { body: JSON.stringify(body) } : {}) });
test("subscription mailbox scopes requests, sanitizes results and encrypts callback codes", async () => {
  const request_id = crypto.randomUUID(), command = { action: "callback", state: "state-fixture", redirect_url: "http://localhost:1455/auth/callback?state=state-fixture&code=private-code" } as const;
  expect((await call("/v1/subscription", f.alienToken, { vm_id: f.vm, request_id, command })).status).toBe(404);
  expect((await call("/v1/subscription", f.client, { vm_id: f.vm, request_id, command })).status).toBe(200);
  expect(JSON.stringify(await f.sql`SELECT command,callback_cipher FROM assistant.subscription_requests WHERE request_id=${request_id}`)).not.toContain("private-code");
  expect((await call("/v1/daemon/subscription/claim", f.client, {})).status).toBe(403);
  const claim_id = crypto.randomUUID();
  const claim = z.object({ request: SubscriptionClaim }).parse(await (await call("/v1/daemon/subscription/claim", f.machine, { claim_id })).json());
  expect(claim.request.command).toEqual(command);
  expect(await (await call("/v1/daemon/subscription/claim", f.machine, { claim_id })).json()).toEqual(claim);
  expect((await call("/v1/daemon/subscription/observed", f.machine, { request_id, result: { action: "callback", accepted: true, access_token: "must-reject" } })).status).toBe(400);
  expect((await call("/v1/daemon/subscription/observed", f.machine, { request_id, result: { action: "callback", accepted: true } })).status).toBe(200);
  const response = await call(`/v1/subscription/${request_id}?vm_id=${f.vm}`, f.client);
  expect(response.headers.get("cache-control")).toBe("no-store");
  expect(SubscriptionReply.parse(await response.json()).status).toBe("completed");
  expect((await f.sql`SELECT callback_cipher FROM assistant.subscription_requests WHERE request_id=${request_id}`)[0]?.["callback_cipher"]).toBeNull();
  expect((await call(`/v1/subscription/${request_id}?vm_id=${f.vm}`, f.alienToken)).status).toBe(404);
});

test("subscription selection rejects supplied keys and uses advertised connection", async () => {
  const selection = { provider: "subscription", model: "kimi-k2", reasoning_effort: "high" };
  expect((await call("/v1/daemon/model-settings/defaults", f.machine, { selection, available: ["subscription"] })).status).toBe(200);
  const save = (api_key?: string) => app.request("/v1/model-settings", { method: "PUT", headers: { authorization: `Bearer ${f.client}`, "content-type": "application/json" }, body: JSON.stringify({ vm_id: f.vm, expected_revision_id: null, selection, ...(api_key ? { api_key } : {}) }) });
  expect((await save("must-not-store")).status).toBe(400);
  expect((await save()).status).toBe(200);
});
