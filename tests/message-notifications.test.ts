import { afterAll, expect, test } from "bun:test";
import { z } from "zod";
import {
  config as nativeConfig,
  createNotificationFixtures,
} from "./native-notifications-fixture.ts";
import { createWire } from "./native-notifications-wire.ts";
import { dispatchNotifications } from "../packages/notifications/dispatch.ts";
import { publishAttentionMessage } from "../packages/notifications/attention.ts";
import { enqueueMessageNotification } from "../packages/notifications/store.ts";
import {
  createResponsibility,
  recordEvaluation,
  snapshot,
} from "../packages/memory/responsibility-store.ts";
import { ResponsibilityInput } from "../packages/memory/responsibility-schema.ts";

const { sql, fixture, cleanup } = createNotificationFixtures();
const config = { ...nativeConfig, private_key: `${nativeConfig.private_key}\n` };
const wire = createWire();
afterAll(async () => {
  await wire.close();
  await cleanup();
});
const Payload = z.object({
  id: z.uuid(),
  content: z.string(),
  role: z.string(),
  task_id: z.uuid().nullable(),
});

test("commentary and final commit their own idempotent intents; heartbeat and success add none", async () => {
  const f = await fixture();
  await f.register();
  const commentary = {
    kind: "message",
    event_id: crypto.randomUUID(),
    run_id: f.run,
    content: "자료를 확인하고 있어요.",
  };
  expect((await f.post(commentary)).status).toBe(200);
  expect((await f.post(commentary)).status).toBe(200);
  expect(
    (await f.post({ kind: "heartbeat", event_id: crypto.randomUUID(), run_id: f.run })).status,
  ).toBe(200);
  expect((await f.complete()).status).toBe(200);
  const rows =
    await sql`SELECT n.message_id,m.content FROM notification_intents n JOIN messages m ON m.id=n.message_id WHERE n.workspace_id=${f.workspace} ORDER BY m.sequence`;
  expect(rows.map((row) => row["content"])).toEqual([commentary.content, "실제 답변이에요 👋"]);
  expect(await f.deliveries()).toHaveLength(2);
  expect((await f.post({ ...commentary, event_id: crypto.randomUUID() })).status).toBe(409);
  expect(await f.deliveries()).toHaveLength(2);
  wire.status = 200;
  const start = wire.messages.length;
  await dispatchNotifications(sql, { fcm: config });
  expect(
    wire.messages
      .slice(start)
      .map((message) => message.data.url)
      .sort(),
  ).toEqual(
    rows.map((row) => `/?conversation=${f.conversation}&message=${row["message_id"]}`).sort(),
  );
});

test("preference defaults on, strict save isolates settings, retry observes off then on", async () => {
  const f = await fixture();
  await f.register();
  await sql`UPDATE workspaces SET persona_name='하늘' WHERE id=${f.workspace}`;
  const revision = (
    await sql`SELECT settings_revision FROM workspaces WHERE id=${f.workspace}`
  )[0]?.["settings_revision"];
  await f.complete();
  wire.status = 503;
  await dispatchNotifications(sql, { fcm: config });
  expect(wire.messages.at(-1)?.notification).toEqual({ title: "하늘", body: "실제 답변이에요 👋" });
  const preference = (body: object) =>
    f.app.request("/v1/notifications/preferences", {
      method: "PUT",
      headers: f.headers,
      body: JSON.stringify(body),
    });
  expect((await preference({ show_content: false, persona_name: "changed" })).status).toBe(400);
  expect((await preference({ show_content: "false" })).status).toBe(400);
  expect(await (await preference({ show_content: false })).json()).toEqual({ show_content: false });
  await f.register("synthetic-rotated-preview-token");
  wire.status = 503;
  await dispatchNotifications(sql, { fcm: config });
  expect(wire.messages.at(-1)?.notification).toEqual({ title: "하늘", body: "새 메시지" });
  expect(JSON.stringify(wire.messages.at(-1))).not.toContain("실제 답변");
  expect(
    await (
      await f.app.request(`/v1/notifications?installation_id=${f.installation}&transport=fcm`, {
        headers: f.headers,
      })
    ).json(),
  ).toMatchObject({ show_content: false });
  expect(await (await preference({ show_content: true })).json()).toEqual({ show_content: true });
  await sql`UPDATE notification_deliveries SET next_attempt_at=now() WHERE intent_id IN (SELECT id FROM notification_intents WHERE workspace_id=${f.workspace})`;
  wire.status = 200;
  await dispatchNotifications(sql, { fcm: config });
  expect(wire.messages.at(-1)?.notification.body).toBe("실제 답변이에요 👋");
  expect(
    (await sql`SELECT persona_name,settings_revision FROM workspaces WHERE id=${f.workspace}`)[0],
  ).toMatchObject({ persona_name: "하늘", settings_revision: revision });
  const other = await fixture();
  expect(
    await (
      await other.app.request(`/v1/notifications?installation_id=${other.installation}`, {
        headers: other.headers,
      })
    ).json(),
  ).toMatchObject({ show_content: true });
});

test("failure publishes actual visible status, never repurposes commentary; statuses dedupe separately", async () => {
  const f = await fixture();
  await f.register();
  await f.post({
    kind: "message",
    event_id: crypto.randomUUID(),
    run_id: f.run,
    content: "곧 확인할게요.",
  });
  f.event.state = "failed";
  expect((await f.complete()).status).toBe(200);
  expect((await f.complete()).status).toBe(200);
  const rows = z
    .array(Payload)
    .parse(
      await sql`SELECT m.id,m.role,m.content,m.task_id FROM messages m WHERE m.workspace_id=${f.workspace} ORDER BY m.sequence`,
    );
  expect(rows).toHaveLength(2);
  expect(rows[1]).toMatchObject({
    role: "system",
    task_id: null,
    content: "작업 오류: 상세 정보가 없습니다.",
  });
  expect(await f.deliveries()).toHaveLength(2);
  await sql.begin((tx) =>
    publishAttentionMessage(tx, f.workspace, { id: f.run, state: "unknown" }),
  );
  await sql.begin((tx) => publishAttentionMessage(tx, f.workspace, { id: f.run, state: "failed" }));
  expect(await f.deliveries()).toHaveLength(3);
  const links =
    await sql`SELECT a.state,m.content FROM notification_attention_messages a JOIN messages m ON m.id=a.message_id WHERE a.run_id=${f.run}`;
  expect(links).toHaveLength(2);
  expect(new Set(links.map((row) => row["content"])).size).toBe(2);
  wire.status = 200;
  await dispatchNotifications(sql, { fcm: config });
  expect(
    wire.messages.some(
      (message) =>
        message.data.id === rows[1]?.id && message.notification.body === rows[1]?.content,
    ),
  ).toBe(true);
});

test("an explicit equivalent failure message is used without a duplicate status", async () => {
  const f = await fixture();
  await f.register();
  await f.post({
    kind: "message",
    event_id: crypto.randomUUID(),
    run_id: f.run,
    content: "작업 오류: 상세 정보가 없습니다.",
  });
  f.event.state = "failed";
  await f.complete();
  expect(await f.deliveries()).toHaveLength(1);
  expect(await sql`SELECT id FROM messages WHERE workspace_id=${f.workspace}`).toHaveLength(1);
});

test("proactive evaluation commits a taskless message and exactly one anchored push", async () => {
  const f = await fixture();
  await f.register();
  const source = crypto.randomUUID();
  await sql`INSERT INTO messages(id,workspace_id,conversation_id,role,content) VALUES(${source},${f.workspace},${f.conversation},'user','Notify me tomorrow')`;
  const principal = { workspace_id: f.workspace, vm_id: f.vm, role: "vm" as const };
  const row = await createResponsibility(
    sql,
    principal,
    ResponsibilityInput.parse({
      client_responsibility_id: crypto.randomUUID(),
      conversation_id: f.conversation,
      vm_id: f.vm,
      source_message_id: source,
      source_quote: "Notify me tomorrow",
      objective: "Notify me tomorrow",
      trigger: { kind: "task_change", task_id: f.task },
    }),
  );
  const current = await snapshot(sql, row);
  const request = {
    responsibility_id: row.id,
    context_hash: current.context_hash,
    evaluation: {
      outcome: "notify" as const,
      reason: "Time to notify",
      notification: "약속한 내용을 확인해 주세요.",
      action_objective: null,
      next_review_minutes: 60,
    },
  };
  await recordEvaluation(sql, principal, request);
  await recordEvaluation(sql, principal, request);
  const message = z
    .object({ id: z.uuid(), task_id: z.null() })
    .parse(
      (
        await sql`SELECT id,task_id FROM messages WHERE workspace_id=${f.workspace} AND role='assistant'`
      )[0],
    );
  expect(await f.deliveries()).toHaveLength(1);
  await enqueueMessageNotification(sql, f.workspace, message);
  expect(await f.deliveries()).toHaveLength(1);
  wire.status = 200;
  await dispatchNotifications(sql, { fcm: config });
  expect(wire.messages.find((item) => item.data.id === message.id)?.data.url).toBe(
    `/?conversation=${f.conversation}&message=${message.id}`,
  );
  expect(wire.messages.find((item) => item.data.id === message.id)?.notification.body).toBe(
    request.evaluation.notification,
  );
});

test("journal-mismatch poll keeps recovery blocked and publishes one status across retries", async () => {
  const f = await fixture();
  await f.register();
  const first = await f.poll(),
    second = await f.poll();
  expect(first.status).toBe(200);
  expect(await first.json()).toMatchObject({ assignment: null, messages: [] });
  expect(await second.json()).toMatchObject({ assignment: null, messages: [] });
  expect((await sql`SELECT state FROM runs WHERE id=${f.run}`)[0]?.["state"]).toBe("unknown");
  expect(await f.deliveries()).toHaveLength(1);
  const status = z
    .object({ role: z.string(), content: z.string() })
    .parse((await sql`SELECT role,content FROM messages WHERE workspace_id=${f.workspace}`)[0]);
  expect(status).toEqual({
    role: "system",
    content: "Daemon restarted without active run journal",
  });
});
