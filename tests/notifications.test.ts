import { expect, test, afterAll } from "bun:test";
import { createApp } from "../services/control/app.ts";
import { hashToken } from "../services/control/auth.ts";
import { dispatchNotifications } from "../packages/notifications/dispatch.ts";
import type { PushSubscription, PushConfig } from "../packages/notifications/schema.ts";
import { config, subscription, sql, fixture, cleanup } from "./notifications-fixture.ts";
afterAll(cleanup);
test("notifications start off; missing config is truthful and rejects registration", async () => {
  const f = await fixture();
  expect(
    await (
      await f.app.request(`/v1/notifications?installation_id=${f.installation}`, {
        headers: f.headers,
      })
    ).json(),
  ).toMatchObject({ configured: true, enabled: false });
  await f.complete();
  expect(await f.deliveries()).toHaveLength(0);
  const unconfigured = createApp(sql);
  expect(
    await (
      await unconfigured.request(`/v1/notifications?installation_id=${f.installation}`, {
        headers: f.headers,
      })
    ).json(),
  ).toEqual({ configured: false, public_key: null, enabled: false, show_content: true });
  expect(
    (
      await unconfigured.request("/v1/notifications/subscription", {
        method: "PUT",
        headers: f.headers,
        body: JSON.stringify({ installation_id: f.installation, subscription }),
      })
    ).status,
  ).toBe(503);
});
test("terminal intent and retry dedupe are transactional; accepted push never reruns task", async () => {
  const f = await fixture();
  expect((await f.register()).status).toBe(200);
  await f.register();
  expect((await f.complete()).status).toBe(200);
  expect((await f.complete()).status).toBe(200);
  expect(await f.deliveries()).toHaveLength(1);
  let calls = 0;
  const payloads: string[] = [];
  const send = async (
    _subscription: PushSubscription,
    _config: PushConfig,
    message: { readonly data: string; readonly expiresAt: number; readonly topic: string },
  ) => {
    calls++;
    payloads.push(message.data);
    expect(message.expiresAt).toBeGreaterThan(Date.now());
    expect(message.topic).toHaveLength(32);
    return { status: calls === 1 ? 429 : 201, retryAfter: "120" };
  };
  await dispatchNotifications(sql, config, send);
  expect((await f.deliveries())[0]?.["state"]).toBe("pending");
  await sql`UPDATE notification_deliveries SET next_attempt_at=now()-interval '1 second' WHERE intent_id=(SELECT id FROM notification_intents WHERE workspace_id=${f.workspace})`;
  await Promise.all([
    dispatchNotifications(sql, config, send),
    dispatchNotifications(sql, config, send),
  ]);
  expect(calls).toBe(2);
  expect(payloads[0]).toBe(payloads[1]);
  expect((await f.deliveries())[0]?.["state"]).toBe("accepted");
  expect((await sql`SELECT state FROM tasks WHERE id=${f.task}`)[0]?.["state"]).toBe("succeeded");
  expect(
    (await sql`SELECT count(*)::int AS count FROM runs WHERE task_id=${f.task}`)[0]?.["count"],
  ).toBe(1);
  const cipher = (
    await sql`SELECT subscription_cipher FROM push_subscriptions WHERE workspace_id=${f.workspace}`
  )[0]?.["subscription_cipher"];
  expect(String(cipher)).not.toContain("fixture-secret-endpoint");
});
test("workspace/credential isolation, mute and logout prevent later sends", async () => {
  const f = await fixture(),
    other = await fixture();
  await f.register();
  await f.complete();
  await other.app.request(`/v1/notifications/subscription/${f.installation}`, {
    method: "DELETE",
    headers: other.headers,
  });
  expect(
    (await sql`SELECT enabled FROM push_subscriptions WHERE workspace_id=${f.workspace}`)[0]?.[
      "enabled"
    ],
  ).toBe(true);
  await f.app.request(`/v1/notifications/subscription/${f.installation}`, {
    method: "DELETE",
    headers: f.headers,
  });
  let sent = 0;
  await dispatchNotifications(sql, config, async () => {
    sent++;
    return { status: 201, retryAfter: null };
  });
  expect(sent).toBe(0);
  expect((await f.deliveries())[0]?.["state"]).toBe("suppressed");
  const g = await fixture(),
    session = crypto.randomUUID(),
    sessionHash = await hashToken(session);
  await sql`INSERT INTO browser_sessions(token_hash,credential_hash,expires_at) VALUES(${sessionHash},${g.credential},now()+interval '1 day')`;
  const cookie = {
    cookie: `assistant_session=${session}`,
    origin: "http://localhost",
    "content-type": "application/json",
  };
  expect(
    (
      await g.app.request("/v1/notifications/subscription", {
        method: "PUT",
        headers: cookie,
        body: JSON.stringify({ installation_id: g.installation, subscription }),
      })
    ).status,
  ).toBe(200);
  await g.complete();
  expect((await g.app.request("/v1/session", { method: "DELETE", headers: cookie })).status).toBe(
    200,
  );
  await dispatchNotifications(sql, config, async () => {
    sent++;
    return { status: 201, retryAfter: null };
  });
  expect(sent).toBe(0);
  expect((await g.deliveries())[0]?.["state"]).toBe("suppressed");
});
test("expired intents never send and dead subscription stops retries", async () => {
  const f = await fixture();
  await f.register();
  await f.complete();
  await sql`UPDATE notification_intents SET expires_at=now()-interval '1 second' WHERE id=(SELECT id FROM notification_intents WHERE workspace_id=${f.workspace})`;
  await dispatchNotifications(sql, config, async () => {
    throw new Error("must not send");
  });
  expect((await f.deliveries())[0]?.["state"]).toBe("expired");
  const g = await fixture();
  await g.register();
  await g.complete();
  await dispatchNotifications(sql, config, async () => ({ status: 410, retryAfter: null }));
  expect((await g.deliveries())[0]?.["state"]).toBe("invalid");
  expect(
    (await sql`SELECT enabled FROM push_subscriptions WHERE workspace_id=${g.workspace}`)[0]?.[
      "enabled"
    ],
  ).toBe(false);
});
test("repeated unknown events enqueue once and heartbeat quarantine creates one intent", async () => {
  const f = await fixture();
  await f.register();
  f.event.state = "unknown";
  expect((await f.complete()).status).toBe(200);
  f.event.event_id = crypto.randomUUID();
  expect((await f.complete()).status).toBe(200);
  expect(await f.deliveries()).toHaveLength(1);
  await f.app.request(`/v1/notifications/subscription/${f.installation}`, {
    method: "DELETE",
    headers: f.headers,
  });
  const g = await fixture();
  await g.register();
  await sql`UPDATE runs SET created_at=now()-interval '10 minutes' WHERE id=${g.run}`;
  const { quarantineStaleRuns } = await import("../services/control/repository/recovery.ts");
  await quarantineStaleRuns(sql);
  await quarantineStaleRuns(sql);
  expect(await g.deliveries()).toHaveLength(1);
  expect(
    (await sql`SELECT outcome FROM notification_intents WHERE run_id=${g.run}`)[0]?.["outcome"],
  ).toBe("message");
  await g.app.request(`/v1/notifications/subscription/${g.installation}`, {
    method: "DELETE",
    headers: g.headers,
  });
});
test("expired worker lease retries once, transient failures exhaust without replay", async () => {
  const f = await fixture();
  await f.register();
  await f.complete();
  await sql`UPDATE notification_deliveries SET state='leased',lease_id=${crypto.randomUUID()},lease_until=now()-interval '1 second',attempts=4 WHERE intent_id=(SELECT id FROM notification_intents WHERE workspace_id=${f.workspace})`;
  let calls = 0;
  await dispatchNotifications(sql, config, async () => {
    calls++;
    throw new Error("synthetic transport failure");
  });
  expect(calls).toBe(1);
  expect((await f.deliveries())[0]).toMatchObject({
    state: "failed",
    last_error: "retry_exhausted:push_transport_failed",
    attempts: 5,
  });
  await dispatchNotifications(sql, config, async () => {
    calls++;
    return { status: 201, retryAfter: null };
  });
  expect(calls).toBe(1);
  expect((await sql`SELECT state FROM tasks WHERE id=${f.task}`)[0]?.["state"]).toBe("succeeded");
});
test("safe failure categories persist without endpoint or exception secrets; redirects never retry", async () => {
  const { PushSendError } = await import("../packages/notifications/dispatch.ts");
  const f = await fixture();
  await f.register();
  await f.complete();
  await dispatchNotifications(sql, config, async () => {
    throw new PushSendError("push_transport_type_error");
  });
  expect((await f.deliveries())[0]).toMatchObject({
    state: "pending",
    last_error: "push_transport_type_error",
  });
  await sql`UPDATE notification_deliveries SET next_attempt_at=now()-interval '1 second' WHERE intent_id=(SELECT id FROM notification_intents WHERE workspace_id=${f.workspace})`;
  await dispatchNotifications(sql, config, async () => ({ status: 307, retryAfter: null }));
  expect((await f.deliveries())[0]).toMatchObject({
    state: "failed",
    last_error: "push_redirect_rejected",
  });
});
