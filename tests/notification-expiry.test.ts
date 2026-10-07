import { afterAll, expect, spyOn, test } from "bun:test";
import { z } from "zod";
import { dispatchNotifications, sendPush } from "../packages/notifications/dispatch.ts";
import { sendFcm } from "../packages/notifications/fcm.ts";
import { config as webConfig, subscription } from "./notifications-fixture.ts";
import { config as fcmConfig, createNotificationFixtures } from "./native-notifications-fixture.ts";

const { sql, fixture, cleanup } = createNotificationFixtures({ web: webConfig, fcm: fcmConfig });
afterAll(cleanup);
const native = { transport: "fcm", platform: "ios", token: "synthetic-expiry-token" } as const;
const data = JSON.stringify({
  id: crypto.randomUUID(),
  title: "Expiry",
  body: "Synthetic",
  url: "/",
});

async function withWire(
  run: (wire: {
    readonly requests: { readonly ttl: number | null; readonly expiration: number | null }[];
    now: number;
    status: number;
    oauthDelay: number;
    onOauth: (() => Promise<void>) | undefined;
  }) => Promise<void>,
) {
  const wire: {
    requests: { readonly ttl: number | null; readonly expiration: number | null }[];
    now: number;
    status: number;
    oauthDelay: number;
    onOauth: (() => Promise<void>) | undefined;
  } = { requests: [], now: Date.now(), status: 200, oauthDelay: 0, onOauth: undefined };
  const server = Bun.serve({
    hostname: "127.0.0.1",
    port: 0,
    async fetch(request) {
      if (new URL(request.url).pathname === "/token") {
        wire.now += wire.oauthDelay;
        await wire.onOauth?.();
        return Response.json({ access_token: "synthetic-token", expires_in: 3600 });
      }
      const ttl = request.headers.get("ttl");
      const expiration =
        ttl === null
          ? Number(
              z
                .object({
                  message: z.object({
                    apns: z.object({ headers: z.record(z.string(), z.string()) }),
                  }),
                })
                .parse(await request.json()).message.apns.headers["apns-expiration"],
            )
          : null;
      wire.requests.push({ ttl: ttl === null ? null : Number(ttl), expiration });
      return new Response(null, { status: wire.status });
    },
  });
  const original = globalThis.fetch;
  globalThis.fetch = Object.assign(
    async (input: RequestInfo | URL, init?: RequestInit) => {
      const request = new Request(input, init);
      return original(new Request(new URL(new URL(request.url).pathname, server.url), request));
    },
    { preconnect: original.preconnect },
  );
  const clock = spyOn(Date, "now").mockImplementation(() => wire.now);
  try {
    await run(wire);
  } finally {
    clock.mockRestore();
    globalThis.fetch = original;
    await server.stop();
  }
}

async function queued(transport: "web" | "fcm") {
  const f = await fixture();
  if (transport === "fcm") await f.register();
  else
    await f.app.request("/v1/notifications/subscription", {
      method: "PUT",
      headers: f.headers,
      body: JSON.stringify({ installation_id: f.installation, subscription }),
    });
  await f.complete();
  const intent = z
    .object({ expires_at: z.string() })
    .parse(
      (await sql`SELECT expires_at FROM notification_intents WHERE workspace_id=${f.workspace}`)[0],
    );
  return { ...f, expiresAt: Date.parse(intent.expires_at) };
}

for (const transport of ["web", "fcm"] as const) {
  test(`${transport} retains the fresh intent lifetime beyond five minutes`, async () => {
    // Given a new durable message with the database's default expiry.
    const f = await queued(transport);
    await withWire(async (wire) => {
      wire.now = f.expiresAt - 86_400_000;
      // When dispatch sends through the real crypto and HTTP adapters.
      await dispatchNotifications(sql, { web: webConfig, fcm: fcmConfig });
      // Then provider storage lasts until the original intent expires.
      expect(wire.requests).toEqual([
        {
          ttl: transport === "web" ? 86400 : null,
          expiration: transport === "fcm" ? Math.floor(f.expiresAt / 1000) : null,
        },
      ]);
      expect((await f.deliveries())[0]?.["state"]).toBe("accepted");
    });
  });
  test(`${transport} uses only the near-expiry remaining lifetime`, async () => {
    // Given 75 seconds left on the same persisted deadline.
    const f = await queued(transport);
    await withWire(async (wire) => {
      wire.now = f.expiresAt - 75_000;
      // When the delivery is sent.
      await dispatchNotifications(sql, { web: webConfig, fcm: fcmConfig });
      // Then no new lifetime is granted.
      expect(wire.requests).toEqual([
        {
          ttl: transport === "web" ? 75 : null,
          expiration: transport === "fcm" ? Math.floor(f.expiresAt / 1000) : null,
        },
      ]);
    });
  });
  test(`${transport} retries retain the original deadline`, async () => {
    // Given a retryable failure and a fixed intent deadline.
    const f = await queued(transport);
    await withWire(async (wire) => {
      wire.now = f.expiresAt - 600_000;
      wire.status = 503;
      await dispatchNotifications(sql, { web: webConfig, fcm: fcmConfig });
      await sql`UPDATE notification_deliveries SET next_attempt_at=now()-interval '1 second' WHERE intent_id IN(SELECT id FROM notification_intents WHERE workspace_id=${f.workspace})`;
      wire.now += 120_000;
      wire.status = 200;
      // When the queued delivery retries two minutes later.
      await dispatchNotifications(sql, { web: webConfig, fcm: fcmConfig });
      // Then elapsed time consumes TTL instead of extending expiry.
      expect(wire.requests).toEqual(
        transport === "web"
          ? [
              { ttl: 600, expiration: null },
              { ttl: 480, expiration: null },
            ]
          : [
              { ttl: null, expiration: Math.floor(f.expiresAt / 1000) },
              { ttl: null, expiration: Math.floor(f.expiresAt / 1000) },
            ],
      );
      expect((await f.deliveries())[0]?.["state"]).toBe("accepted");
    });
  });
  test(`${transport} expires a lease without a provider call when time elapses before send`, async () => {
    // Given a database-selected intent whose local deadline has just passed.
    const f = await queued(transport);
    await withWire(async (wire) => {
      wire.now = f.expiresAt + 1;
      // When dispatch reaches its send boundary.
      await dispatchNotifications(sql, { web: webConfig, fcm: fcmConfig });
      // Then expiry releases the lease and never emits TTL zero.
      expect(wire.requests).toHaveLength(0);
      expect((await f.deliveries())[0]).toMatchObject({
        state: "expired",
        lease_id: null,
        lease_until: null,
      });
    });
  });
}

test("FCM OAuth preparation cannot move APNs absolute expiry", async () => {
  // Given a one-minute message and five seconds of OAuth preparation.
  await withWire(async (wire) => {
    const expiresAt = wire.now + 60_000;
    wire.oauthDelay = 5000;
    // When the real sender signs and acquires an access token.
    await sendFcm(
      native,
      { ...fcmConfig, client_email: `${crypto.randomUUID()}@example.test` },
      { data, expiresAt, topic: "expiry" },
    );
    // Then APNs receives the original deadline, rounded down to seconds.
    expect(wire.requests).toEqual([{ ttl: null, expiration: Math.floor(expiresAt / 1000) }]);
  });
});

test("FCM expiry during OAuth marks the owned lease expired without sending", async () => {
  // Given an intent that expires while OAuth is being acquired.
  const f = await queued("fcm");
  await withWire(async (wire) => {
    wire.now = f.expiresAt - 5000;
    wire.oauthDelay = 6000;
    // When OAuth completes after its deadline.
    await dispatchNotifications(sql, {
      fcm: { ...fcmConfig, client_email: `${crypto.randomUUID()}@example.test` },
    });
    // Then no FCM send occurs and the owned lease expires.
    expect(wire.requests).toHaveLength(0);
    expect((await f.deliveries())[0]).toMatchObject({ state: "expired", lease_id: null });
  });
});

test("FCM expiry after registration rotation cannot finalize the replacement lease", async () => {
  // Given a delivery whose registration rotates during OAuth preparation.
  const f = await queued("fcm");
  await withWire(async (wire) => {
    wire.now = f.expiresAt - 5000;
    wire.oauthDelay = 6000;
    wire.onOauth = async () => {
      expect((await f.register("synthetic-rotated-expiry-token")).status).toBe(200);
    };
    // When the old sender discovers expiry after its lease was invalidated.
    await dispatchNotifications(sql, {
      fcm: { ...fcmConfig, client_email: `${crypto.randomUUID()}@example.test` },
    });
    // Then the expired sender cannot overwrite the replacement's pending state.
    expect(wire.requests).toHaveLength(0);
    expect((await f.deliveries())[0]).toMatchObject({ state: "pending", lease_id: null });
    await sql`UPDATE notification_intents SET expires_at=now()-interval '1 second' WHERE workspace_id=${f.workspace}`;
  });
});

for (const delay of [5000, 61_000]) {
  test(`Web Push recomputes expiry after ${delay}ms of crypto preparation`, async () => {
    // Given delayed VAPID signing at the real crypto seam.
    await withWire(async (wire) => {
      const expiresAt = wire.now + 60_000;
      const sign = crypto.subtle.sign.bind(crypto.subtle);
      let delayed = false;
      const signing = spyOn(crypto.subtle, "sign").mockImplementation(async (...args) => {
        const result = await sign(...args);
        if (!delayed) {
          delayed = true;
          wire.now += delay;
        }
        return result;
      });
      try {
        // When encryption/signing consumes some or all of the remaining lifetime.
        const result = sendPush(subscription, webConfig, { data, expiresAt, topic: "expiry" });
        // Then the wire TTL excludes preparation, or the provider is not called.
        if (delay < 60_000) {
          await result;
          expect(wire.requests).toEqual([{ ttl: 55, expiration: null }]);
        } else {
          await expect(result).rejects.toMatchObject({ code: "notification_expired" });
          expect(wire.requests).toHaveLength(0);
        }
      } finally {
        signing.mockRestore();
      }
    });
  });
}
