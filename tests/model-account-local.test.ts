import { expect, test } from "bun:test";
import { createApp } from "../services/control/app.ts";
import { controlFixture } from "./control-fixture.ts";
const f = controlFixture();
const app = createApp(f.sql, { extensionKey: btoa("l".repeat(32)) });
const call = (path: string, token: string, body?: unknown) => app.request(path, { method: body ? "POST" : "GET", headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" }, ...(body ? { body: JSON.stringify(body) } : {}) });
test("local login relays only a bound encrypted callback and clears it on completion", async () => {
  // Given a local loopback receiver and an otherwise idle VM.
  const request_id = crypto.randomUUID(), redirect_uri = "http://127.0.0.1:43291/auth/callback", state = "fixture-bound-state-123456789";
  const request = { vm_id: f.vm, request_id, action: "connect", login_location: "local", redirect_uri };
  for (const invalid of ["https://example.com/callback", "http://localhost:43291/auth/callback", "http://127.0.0.1:43291/other", "broken"])
    expect((await call("/v1/model-account", f.client, { ...request, redirect_uri: invalid })).status).toBe(400);
  expect((await call("/v1/model-account", f.alienToken, request)).status).toBe(404);
  expect((await call("/v1/model-account", f.client, request)).status).toBe(200);
  expect((await call("/v1/model-account", f.client, { ...request, redirect_uri: "http://127.0.0.1:43292/auth/callback" })).status).toBe(409);
  expect((await call("/v1/model-account", f.client, { ...request, login_location: "vm", redirect_uri: undefined })).status).toBe(409);
  expect(await (await call("/v1/daemon/model-account/claim", f.machine, {})).json()).toMatchObject({ request: { request_id, login_location: "local", redirect_uri } });
  const url = new URL("https://auth.openai.com/api/accounts/authorize");
  url.search = new URLSearchParams({ client_id: "fixture-client", redirect_uri, state, nonce: "fixture-nonce", code_challenge_method: "S256", code_challenge: "a".repeat(43) }).toString();
  expect((await call("/v1/daemon/model-account/authorization", f.machine, { request_id, authorization_url: url.href + "&id_token_hint=forbidden" })).status).toBe(400);
  expect((await call("/v1/daemon/model-account/authorization", f.machine, { request_id, authorization_url: url.href })).status).toBe(200);
  const location = `/v1/model-account/authorization?vm_id=${f.vm}&request_id=${request_id}`;
  expect((await call(location, f.alienToken)).status).toBe(404);
  expect(await (await call(location, f.client)).json()).toEqual({ authorization_url: url.href });
  const callback = { state, code: "synthetic-authorization-code", client_id: "fixture-client" };
  // When the local receiver submits its callback, mismatched and duplicated callbacks are rejected.
  expect((await call("/v1/model-account/callback", f.client, { vm_id: f.vm, request_id, callback: { ...callback, state: "wrong-state-123456" } })).status).toBe(400);
  expect((await call("/v1/model-account/callback", f.client, { vm_id: f.vm, request_id, callback })).status).toBe(200);
  expect((await call("/v1/model-account/callback", f.client, { vm_id: f.vm, request_id, callback })).status).toBe(200);
  expect((await call("/v1/model-account/callback", f.client, { vm_id: f.vm, request_id, callback: { ...callback, code: "other" } })).status).toBe(409);
  // Then only the owning VM receives the code; neither status nor stored ciphertext exposes it.
  const path = `/v1/daemon/model-account/callback?request_id=${request_id}`;
  expect((await call(path, f.client)).status).toBe(403);
  expect(await (await call(path, f.machine)).json()).toEqual({ callback });
  expect(JSON.stringify(await f.sql`SELECT callback_cipher FROM assistant.chatgpt_accounts WHERE vm_id=${f.vm}`)).not.toContain(callback.code);
  expect(await (await call(`/v1/model-account?vm_id=${f.vm}`, f.client)).text()).not.toContain(callback.code);
  expect((await call("/v1/daemon/model-account/observed", f.machine, { request_id, state: "connected", error_code: null })).status).toBe(200);
  expect((await call(path, f.machine)).status).toBe(409);
  expect((await f.sql`SELECT callback_cipher,authorization_url FROM assistant.chatgpt_accounts WHERE vm_id=${f.vm}`)[0]).toMatchObject({ callback_cipher: null, authorization_url: null });
});
