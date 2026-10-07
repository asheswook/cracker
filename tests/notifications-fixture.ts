import { createDatabase } from "../services/control/db.ts";
import { createApp } from "../services/control/app.ts";
import { hashToken } from "../services/control/auth.ts";
import { PushConfig, PushSubscription } from "../packages/notifications/schema.ts";
export const sql = createDatabase(
  process.env["TEST_DATABASE_URL"] ?? "postgres://assistant:assistant@127.0.0.1:55439/assistant_dev",
);
const fixtureWorkspaces: string[] = [];
export async function cleanup() {
  for (const workspace of fixtureWorkspaces) await sql.begin(async tx => {
    await tx`DELETE FROM notification_deliveries WHERE intent_id IN (SELECT id FROM notification_intents WHERE workspace_id=${workspace})`;
    await tx`DELETE FROM notification_intents WHERE workspace_id=${workspace}`;
    await tx`DELETE FROM push_subscriptions WHERE workspace_id=${workspace}`;
    await tx`DELETE FROM browser_sessions WHERE credential_hash IN (SELECT token_hash FROM credentials WHERE workspace_id=${workspace})`;
    await tx`DELETE FROM outbox WHERE workspace_id=${workspace}`;
    await tx`DELETE FROM events WHERE workspace_id=${workspace}`;
    await tx`DELETE FROM notification_attention_messages WHERE run_id IN (SELECT id FROM runs WHERE workspace_id=${workspace})`;
    await tx`DELETE FROM messages WHERE workspace_id=${workspace}`;
    await tx`DELETE FROM runs WHERE workspace_id=${workspace}`;
    await tx`DELETE FROM tasks WHERE workspace_id=${workspace}`;
    await tx`DELETE FROM credentials WHERE workspace_id=${workspace}`;
    await tx`DELETE FROM conversations WHERE workspace_id=${workspace}`;
    await tx`DELETE FROM vms WHERE workspace_id=${workspace}`;
    await tx`DELETE FROM workspaces WHERE id=${workspace}`;
  });
  await sql.end();
}
const encode = (bytes: ArrayBuffer) => Buffer.from(bytes).toString("base64url");
const pair = await crypto.subtle.generateKey({ name: "ECDSA", namedCurve: "P-256" }, true, [
  "sign",
  "verify",
]);
const jwk = await crypto.subtle.exportKey("jwk", pair.privateKey);
export const config = PushConfig.parse({
  subject: "mailto:test@example.com",
  publicKey: encode(await crypto.subtle.exportKey("raw", pair.publicKey)),
  privateKey: jwk.d,
  encryptionKey: Buffer.alloc(32, 42).toString("base64"),
});
export const subscription = PushSubscription.parse({
  endpoint: "https://fcm.googleapis.com/fcm/send/fixture-secret-endpoint",
  keys: { p256dh: config.publicKey, auth: Buffer.alloc(16, 3).toString("base64url") },
});
export async function fixture() {
  const workspace = crypto.randomUUID(),
    vm = crypto.randomUUID(),
    conversation = crypto.randomUUID(),
    task = crypto.randomUUID(),
    run = crypto.randomUUID(),
    installation = crypto.randomUUID();
  const client = crypto.randomUUID() + crypto.randomUUID(),
    daemon = crypto.randomUUID() + crypto.randomUUID(),
    credential = await hashToken(client);
  await sql`INSERT INTO workspaces(id,name) VALUES(${workspace},'notification-test')`;
  fixtureWorkspaces.push(workspace);
  await sql`INSERT INTO credentials(token_hash,workspace_id,role) VALUES(${credential},${workspace},'client')`;
  await sql`INSERT INTO vms(id,workspace_id,name) VALUES(${vm},${workspace},'fixture')`;
  await sql`INSERT INTO credentials(token_hash,workspace_id,role,vm_id) VALUES(${await hashToken(daemon)},${workspace},'vm',${vm})`;
  await sql`INSERT INTO conversations(id,workspace_id,title) VALUES(${conversation},${workspace},'notification')`;
  await sql`INSERT INTO tasks(id,workspace_id,conversation_id,objective,state) VALUES(${task},${workspace},${conversation},'fixture','running')`;
  await sql`INSERT INTO runs(id,workspace_id,task_id,vm_id,state) VALUES(${run},${workspace},${task},${vm},'running')`;
  const app = createApp(sql, { notificationConfig: config }),
    headers = { authorization: `Bearer ${client}`, "content-type": "application/json" };
  const event = {
    kind: "state",
    event_id: crypto.randomUUID(),
    run_id: run,
    state: "succeeded",
    reason: null,
  };
  const finishId = crypto.randomUUID();
  const post = (body: object) => app.request("/v1/daemon/events", { method: "POST", headers: { authorization: `Bearer ${daemon}`, "content-type": "application/json" }, body: JSON.stringify(body) });
  return {
    post,
    workspace,
    vm,
    conversation,
    task,
    run,
    installation,
    credential,
    app,
    headers,
    event,
    register: () =>
      app.request("/v1/notifications/subscription", {
        method: "PUT",
        headers,
        body: JSON.stringify({ installation_id: installation, subscription }),
      }),
    complete: async () => {
      if (event.state !== "succeeded") return post(event);
      const message = await post({ kind: "message", event_id: event.event_id, run_id: run, content: "실제 답변이에요 👋" });
      if (message.status !== 200) return message;
      return post({ ...event, event_id: finishId });
    },
    deliveries: () =>
      sql`SELECT d.* FROM notification_deliveries d JOIN notification_intents n ON n.id=d.intent_id WHERE n.workspace_id=${workspace}`,
  };
}
