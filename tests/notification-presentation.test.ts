import { expect, test } from "bun:test";
import { buildPushPayload } from "@block65/webcrypto-web-push";
import {
  boundedPreview,
  notificationPresentation,
} from "../packages/notifications/presentation.ts";
import { PushConfig, PushSubscription } from "../packages/notifications/schema.ts";

const source = {
  persona_name: "하늘",
  notification_show_content: true,
  content: "# 결과\n**완료**: [보고서](https://example.com)\n```ts\nconst x = 1;\n```",
  attachment_names: [],
};
test("plain preview is stored text without Markdown decoration or an invented summary", () => {
  expect(notificationPresentation(source)).toEqual({
    title: "하늘",
    body: "결과 완료: 보고서 const x = 1;",
  });
  expect(notificationPresentation({ ...source, notification_show_content: false })).toEqual({
    title: "하늘",
    body: "새 메시지",
  });
});

test("Unicode and JSON escaping fit actual encrypted Web Push and native payload budgets", async () => {
  const grapheme = '가👨‍👩‍👧‍👦e\u0301"\\';
  const body = boundedPreview(grapheme.repeat(1000));
  expect(new TextEncoder().encode(JSON.stringify(body)).length).toBeLessThanOrEqual(2400);
  expect(body.endsWith("…")).toBe(true);
  expect(body.includes("\uFFFD")).toBe(false);
  const segments = [
    ...new Intl.Segmenter(undefined, { granularity: "grapheme" }).segment(body.slice(0, -1)),
  ].map((item) => item.segment);
  expect(
    segments.every((segment) =>
      [...new Intl.Segmenter(undefined, { granularity: "grapheme" }).segment(grapheme)].some(
        (item) => item.segment === segment,
      ),
    ),
  ).toBe(true);
  const presentation = { title: "👨‍👩‍👧‍👦".repeat(7), body };
  const data = {
    id: crypto.randomUUID(),
    url: `/?conversation=${crypto.randomUUID()}&message=${crypto.randomUUID()}`,
  };
  const serialized = JSON.stringify({ ...data, ...presentation });
  expect(new TextEncoder().encode(serialized).length).toBeLessThan(3993);
  const fcm = {
    notification: presentation,
    data,
    apns: { payload: { aps: { sound: "default", alert: presentation } } },
  };
  // Check FCM common fields and the resulting APNs payload independently (not duplicate alerts).
  expect(
    new TextEncoder().encode(
      JSON.stringify({
        notification: presentation,
        data,
        apns: { payload: { aps: { sound: "default" } } },
      }),
    ).length,
  ).toBeLessThan(4096);
  expect(
    new TextEncoder().encode(JSON.stringify({ ...fcm.apns.payload, ...data })).length,
  ).toBeLessThan(4096);
  const pair = await crypto.subtle.generateKey({ name: "ECDSA", namedCurve: "P-256" }, true, [
    "sign",
    "verify",
  ]);
  const jwk = await crypto.subtle.exportKey("jwk", pair.privateKey);
  const scalar = Buffer.from(jwk.d ?? "", "base64url");
  const config = PushConfig.parse({
    subject: "mailto:test@example.com",
    publicKey: Buffer.from(await crypto.subtle.exportKey("raw", pair.publicKey)).toString(
      "base64url",
    ),
    privateKey: Buffer.concat([Buffer.alloc(32 - scalar.length), scalar]).toString("base64url"),
    encryptionKey: Buffer.alloc(32).toString("base64"),
  });
  const subscription = PushSubscription.parse({
    endpoint: "https://fcm.googleapis.com/test",
    keys: { p256dh: config.publicKey, auth: Buffer.alloc(16).toString("base64url") },
  });
  const encrypted = await buildPushPayload(
    { data: serialized, options: { ttl: 60 } },
    subscription,
    config,
  );
  expect(encrypted.body?.byteLength).toBe(4096);
});
