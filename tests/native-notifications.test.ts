import { expect, test, afterAll } from "bun:test";
import { config, fixture, sql, cleanup } from "./native-notifications-fixture.ts";
import { dispatchNotifications } from "../packages/notifications/dispatch.ts";
import { notificationConfig } from "../packages/notifications/config.ts";
import { hashToken } from "../services/control/auth.ts";

import { createWire } from "./native-notifications-wire.ts";
const wire = createWire();
const messages = wire.messages;
afterAll(async () => {
  await wire.close();
  await cleanup();
});

test("native status and FCM dispatch work without VAPID; encrypted registration deduplicates terminal events", async () => {
  // Given a native-only configured app and real PostgreSQL fixture.
  const f = await fixture();
  const env = notificationConfig({
    FCM_SERVICE_ACCOUNT_JSON: JSON.stringify(config),
    EXTENSION_ENCRYPTION_KEY: config.encryptionKey,
    VAPID_PUBLIC_KEY: "broken",
  });
  expect(env.fcm).toBeDefined();
  expect(env.web).toBeUndefined();
  expect(
    await (
      await f.app.request(`/v1/notifications?installation_id=${f.installation}&transport=fcm`, {
        headers: f.headers,
      })
    ).json(),
  ).toEqual({ configured: true, public_key: null, enabled: false, show_content: true });
  expect((await f.register()).status).toBe(200);
  await f.complete();
  await f.complete();
  // When the real sender reaches an HTTP-level fake provider.
  wire.status = 200;
  await dispatchNotifications(sql, { fcm: config });
  // Then it accepts one durable delivery, using a signed OAuth grant and private encrypted storage.
  expect(await f.deliveries()).toHaveLength(1);
  expect((await f.deliveries())[0]?.["state"]).toBe("accepted");
  const messageId = (await f.deliveries())[0]?.["intent_id"];
  expect(messages.at(-1)?.data).toEqual({ id: messageId, url: `/?conversation=${f.conversation}&message=${messageId}` });
  expect(messages.at(-1)?.notification).toEqual({ title: "크래커", body: "실제 답변이에요 👋" });
  expect(wire.oauthCalls).toBe(1);
  expect(
    (
      await sql`SELECT subscription_cipher FROM push_subscriptions WHERE workspace_id=${f.workspace}`
    )[0]?.["subscription_cipher"],
  ).not.toContain("synthetic-token-original");
});

for (const scenario of [
  {
    status: 404,
    error: "UNREGISTERED",
    state: "invalid",
    enabled: false,
    reason: "fcm_unregistered",
  },
  {
    status: 404,
    error: "NOT_FOUND",
    state: "pending",
    enabled: true,
    reason: "fcm_request_rejected",
  },
  {
    status: 403,
    error: "SENDER_ID_MISMATCH",
    state: "pending",
    enabled: true,
    reason: "fcm_auth_failed",
  },
  {
    status: 429,
    error: "QUOTA_EXCEEDED",
    state: "pending",
    enabled: true,
    reason: "fcm_rate_limited",
  },
  { status: 503, error: "UNAVAILABLE", state: "pending", enabled: true, reason: "fcm_unavailable" },
])
  test(`FCM ${scenario.status}/${scenario.error} preserves correct token validity`, async () => {
    // Given an enabled native installation and a queued terminal event.
    const f = await fixture();
    await f.register();
    await f.complete();
    wire.status = scenario.status;
    wire.errorCode = scenario.error;
    // When the provider responds.
    await dispatchNotifications(sql, { fcm: config });
    // Then only UNREGISTERED disables the token; transient/configuration failures remain retryable.
    expect((await f.deliveries())[0]).toMatchObject({
      state: scenario.state,
      last_error: scenario.reason,
    });
    expect(
      (await sql`SELECT enabled FROM push_subscriptions WHERE workspace_id=${f.workspace}`)[0]?.[
        "enabled"
      ],
    ).toBe(scenario.enabled);
  });

test("rotation while old delivery is in flight fences UNREGISTERED and delivers the replacement", async () => {
  // Given an old token whose leased send is in progress.
  const f = await fixture();
  await f.register();
  await f.complete();
  wire.status = 404;
  wire.errorCode = "UNREGISTERED";
  wire.onSend = async () => {
    wire.onSend = undefined;
    expect((await f.register("synthetic-token-rotated")).status).toBe(200);
  };
  // When registration rotates the token before the old provider response returns.
  await dispatchNotifications(sql, { fcm: config });
  // Then the stale result cannot disable or finalize the replacement's pending delivery.
  expect((await f.deliveries())[0]?.["state"]).toBe("pending");
  expect(
    (await sql`SELECT enabled FROM push_subscriptions WHERE workspace_id=${f.workspace}`)[0]?.[
      "enabled"
    ],
  ).toBe(true);
  wire.status = 200;
  await dispatchNotifications(sql, { fcm: config });
  expect((await f.deliveries())[0]?.["state"]).toBe("accepted");
  expect(messages.at(-1)?.token).toBe("synthetic-token-rotated");
  expect(wire.oauthCalls).toBe(1);
});

test("session isolation and explicit opt-out suppress native sends", async () => {
  // Given a session-owned native registration.
  const f = await fixture(),
    session = crypto.randomUUID();
  await sql`INSERT INTO browser_sessions(token_hash,credential_hash,expires_at) VALUES(${await hashToken(session)},${f.credential},now()+interval '1 day')`;
  const headers = {
    cookie: `assistant_session=${session}`,
    origin: "http://localhost",
    "content-type": "application/json",
  };
  expect(
    (
      await f.app.request("/v1/notifications/subscription", {
        method: "PUT",
        headers,
        body: JSON.stringify({
          installation_id: f.installation,
          subscription: { transport: "fcm", platform: "macos", token: "synthetic-session-token" },
        }),
      })
    ).status,
  ).toBe(200);
  await f.complete();
  expect(
    await (
      await f.app.request(`/v1/notifications?installation_id=${f.installation}&transport=fcm`, {
        headers: f.headers,
      })
    ).json(),
  ).toMatchObject({ enabled: false });
  await f.app.request(`/v1/notifications/subscription/${f.installation}`, {
    method: "DELETE",
    headers: f.headers,
  });
  expect(
    (await sql`SELECT enabled FROM push_subscriptions WHERE workspace_id=${f.workspace}`)[0]?.[
      "enabled"
    ],
  ).toBe(true);
  const before = messages.length;
  // When its owning session opts out.
  await f.app.request(`/v1/notifications/subscription/${f.installation}`, {
    method: "DELETE",
    headers,
  });
  await dispatchNotifications(sql, { fcm: config });
  // Then no provider request is issued and the queue is suppressed.
  expect(messages.length).toBe(before);
  expect((await f.deliveries())[0]?.["state"]).toBe("suppressed");
});

test("invalid service-account key retries safely without disabling a valid native registration", async () => {
  // Given a registered installation and a structurally present but unusable key.
  const f = await fixture();
  await f.register();
  await f.complete();
  const broken = {
    ...config,
    private_key: "-----BEGIN PRIVATE KEY-----\ninvalid\n-----END PRIVATE KEY-----",
  };
  const before = messages.length;
  // When dispatch cannot sign the OAuth grant.
  await dispatchNotifications(sql, { fcm: broken });
  // Then only a safe configuration reason is persisted, with registration still enabled.
  expect((await f.deliveries())[0]).toMatchObject({
    state: "pending",
    last_error: "fcm_config_invalid",
  });
  expect(
    (await sql`SELECT enabled FROM push_subscriptions WHERE workspace_id=${f.workspace}`)[0]?.[
      "enabled"
    ],
  ).toBe(true);
  expect(messages.length).toBe(before);
});

test("native credential revocation suppresses an already queued result", async () => {
  // Given a queued native result for an active credential.
  const f = await fixture();
  await f.register();
  await f.complete();
  const before = messages.length;
  // When the credential is revoked before dispatch.
  await sql`UPDATE credentials SET revoked_at=now() WHERE token_hash=${f.credential}`;
  await dispatchNotifications(sql, { fcm: config });
  // Then it never reaches the provider.
  expect((await f.deliveries())[0]?.["state"]).toBe("suppressed");
  expect(messages.length).toBe(before);
});

test("native expired intent cannot send even after a recovered lease", async () => {
  // Given an expired intent whose worker lease also expired.
  const f = await fixture();
  await f.register();
  await f.complete();
  await sql`UPDATE notification_intents SET expires_at=now()-interval '1 second' WHERE id=(SELECT id FROM notification_intents WHERE workspace_id=${f.workspace})`;
  await sql`UPDATE notification_deliveries SET state='leased',lease_id=${crypto.randomUUID()},lease_until=now()-interval '1 second' WHERE intent_id=(SELECT id FROM notification_intents WHERE workspace_id=${f.workspace})`;
  const before = messages.length;
  // When recovery runs.
  await dispatchNotifications(sql, { fcm: config });
  // Then expiration wins over redelivery.
  expect((await f.deliveries())[0]?.["state"]).toBe("expired");
  expect(messages.length).toBe(before);
});

test("attachment-only messages use their actual filename, including on the FCM wire", async () => {
  const f = await fixture();
  await f.register();
  const artifact = crypto.randomUUID();
  await sql`INSERT INTO artifacts(id,workspace_id,conversation_id,name,media_type,bytes,sha256,object_key,state,lease_id) VALUES(${artifact},${f.workspace},${f.conversation},'실제 보고서 📎.pdf','application/pdf',1,${"0".repeat(64)},${artifact},'ready',${crypto.randomUUID()})`;
  expect(
    (
      await f.post({
        kind: "message",
        event_id: crypto.randomUUID(),
        run_id: f.run,
        content: "",
        attachment_ids: [artifact],
      })
    ).status,
  ).toBe(200);
  wire.status = 200;
  await dispatchNotifications(sql, { fcm: config });
  const messageId = (await f.deliveries())[0]?.["intent_id"];
  expect(wire.messages.find((item) => item.data.id === messageId)?.notification.body).toBe(
    "실제 보고서 📎.pdf",
  );
});
