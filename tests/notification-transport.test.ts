import { expect, test } from "bun:test";
import { buildPushPayload } from "@block65/webcrypto-web-push";
import { PushSubscription } from "../packages/notifications/schema.ts";
import { config, subscription } from "./notifications-fixture.ts";
test("real WebCrypto library generates modern encrypted payload and rejects arbitrary endpoints", async () => {
  const payload = await buildPushPayload(
    { data: "synthetic notification", options: { ttl: 60, topic: "fixture" } },
    subscription,
    config,
  );
  expect(new Headers(payload.headers).get("content-encoding")).toBe("aes128gcm");
  expect(new Headers(payload.headers).get("authorization")).toStartWith("vapid ");
  expect(payload.body?.byteLength).toBe(4096);
  for (const endpoint of [
    "https://example.com/push",
    "http://127.0.0.1/push",
    "https://fcm.googleapis.com.attacker.test/push",
    "https://user:pass@fcm.googleapis.com/push",
  ])
    expect(PushSubscription.safeParse({ ...subscription, endpoint }).success).toBe(false);
});
test("real sender emits encrypted POST and exposes redirect status to dispatch", async () => {
  const { sendPush } = await import("../packages/notifications/dispatch.ts");
  const original = globalThis.fetch;
  const requests: { method: string;  bytes: number; encoding: string | null }[] =
    [];
  globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const request = new Request(input, init);
    requests.push({
      method: request.method,

      bytes: (await request.arrayBuffer()).byteLength,
      encoding: request.headers.get("content-encoding"),
    });
    return new Response(null, {
      status: 307,
      headers: { location: "https://example.com/must-not-follow" },
    });
  }) as typeof fetch;
  try {
    const result = await sendPush(subscription, config, {
      data: "synthetic",
      expiresAt: Date.now() + 60_000,
      topic: "fixture",
    });
    expect(result.status).toBe(307);
    expect(requests).toEqual([
      { method: "POST",  bytes: 4096, encoding: "aes128gcm" },
    ]);
  } finally {
    globalThis.fetch = original;
  }
});
