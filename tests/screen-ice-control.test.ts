import { expect, test } from "bun:test";
import { Hono } from "hono";
import { DomainError } from "../packages/protocol";
import { createApp } from "../services/control/app";
import { authenticate, hashToken, type AppEnv } from "../services/control/auth";
import { screenIceRoutes } from "../services/control/screen-ice";
import { controlFixture } from "./control-fixture";

const fixture = controlFixture();
const path = () => `/v1/vms/${fixture.vm}/screen/ice`;
const config = { SCREEN_TURN_KEY_ID: "test-key", SCREEN_TURN_API_TOKEN: "test-only-token" };
const configured = createApp(fixture.sql, { screenTurn: config });

test("owned VM receives direct ICE when TURN is not configured", async () => {
  // Given an authenticated client and its VM with TURN disabled.
  // When asking for credentials.
  const response = await fixture.request(path(), fixture.client, undefined, "POST");
  // Then direct operation remains explicit and uncacheable.
  expect(response.status).toBe(200);
  expect(await response.json()).toEqual({ mode: "direct", iceServers: [], expiresAt: null });
  expect(response.headers.get("cache-control")).toBe("no-store");
});

test("credential endpoint rejects anonymous clients before provider access", async () => {
  // Given configured TURN without authentication.
  // When requesting credentials.
  const response = await configured.request(path(), { method: "POST" });
  // Then issuance is denied.
  expect(response.status).toBe(401);
});

test("cross-workspace VM access is denied before provider access", async () => {
  // Given an authenticated client in another workspace.
  // When requesting this VM's credentials.
  const response = await configured.request(path(), { method: "POST", headers: { Authorization: `Bearer ${fixture.alienToken}` } });
  // Then resource existence is not exposed.
  expect(response.status).toBe(404);
});

test("VM token cannot request client credential endpoint", async () => {
  // Given a VM audience credential.
  // When requesting the browser route.
  const response = await configured.request(path(), { method: "POST", headers: { Authorization: `Bearer ${fixture.machine}` } });
  // Then the audience barrier denies access.
  expect(response.status).toBe(403);
});

test("VM token cannot request another VM in its own workspace", async () => {
  // Given another VM resource in the same workspace.
  const other = crypto.randomUUID();
  await fixture.sql`INSERT INTO assistant.vms(id,workspace_id,name) VALUES(${other},${fixture.workspace},'turn-test-other')`;
  // When requesting that resource with this VM's credential.
  const response = await configured.request(`/v1/daemon/vms/${other}/screen/ice`, { method: "POST", headers: { Authorization: `Bearer ${fixture.machine}` } });
  // Then VM identity remains isolated within the workspace.
  expect(response.status).toBe(404);
});

test("VM token receives its own direct credential configuration", async () => {
  // Given the daemon audience route for its registered VM.
  // When requesting ICE.
  const response = await fixture.request(`/v1/daemon/vms/${fixture.vm}/screen/ice`, fixture.machine, undefined, "POST");
  // Then it authenticates through the existing daemon boundary.
  expect(response.status).toBe(200);
});

test("cookie credential issuance requires same-origin POST", async () => {
  // Given a real browser session bound to the test credential.
  const token = crypto.randomUUID() + crypto.randomUUID();
  await fixture.sql`INSERT INTO assistant.browser_sessions(token_hash,credential_hash,expires_at) VALUES(${await hashToken(token)},${await hashToken(fixture.client)},now()+interval '1 hour')`;
  // When a cross-site page posts to the issuance route.
  const response = await configured.request(`https://control.test${path()}`, { method: "POST", headers: { Cookie: `assistant_session=${token}`, Origin: "https://alien.test" } });
  // Then CSRF is rejected before issuance.
  expect(response.status).toBe(403);
});

test("issuance permits rapid reconnects through sixty requests and rejects excess before provider access", async () => {
  // Given real authentication and storage with a narrow provider stand-in.
  let issued = 0;
  const app = new Hono<AppEnv>();
  app.use("*", async (c, next) => {
    c.set("principal", await authenticate(fixture.sql, c.req.header("Authorization")));
    await next();
  });
  app.route("/v1", screenIceRoutes(fixture.sql, config, async () => {
    issued++;
    return { mode: "turn", iceServers: [{ urls: "turns:relay.example:443", username: "test", credential: "test-only" }], expiresAt: Date.now() + 3600000 };
  }));
  app.onError((error, c) => {
    if (error instanceof DomainError) return c.json({ code: error.code }, error.status);
    throw error;
  });
  const responses: Response[] = [];
  // When a client rapidly reopens its VM screen through the one-minute budget.
  for (let index = 0; index < 61; index++) responses.push(await app.request(path(), { method: "POST", headers: { Authorization: `Bearer ${fixture.client}` } }));
  // Then excess requests cannot reach the provider and remain uncacheable.
  expect(responses.map((response) => response.status)).toEqual([...Array<number>(60).fill(200), 429]);
  expect(issued).toBe(60);
  expect(responses.at(-1)?.headers.get("retry-after")).toBe("60");
  expect(responses.every((response) => response.headers.get("cache-control") === "no-store")).toBe(true);
});
