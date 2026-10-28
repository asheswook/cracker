import { exportPKCS8, generateKeyPair } from "jose";
import { createDatabase } from "../services/control/db.ts";
import { createApp } from "../services/control/app.ts";
import { hashToken } from "../services/control/auth.ts";
import { FcmConfig, type NotificationConfig } from "../packages/notifications/config.ts";
export const keys = await generateKeyPair("RS256", { extractable: true });
export const config = FcmConfig.parse({
  project_id: "test-native-project",
  client_email: "test@example.iam.gserviceaccount.com",
  private_key: await exportPKCS8(keys.privateKey),
  encryptionKey: Buffer.alloc(32, 42).toString("base64"),
});
export function createNotificationFixtures(notificationConfig: NotificationConfig = { fcm: config }) {
  const sql = createDatabase(
    process.env["TEST_DATABASE_URL"] ?? "postgres://assistant:assistant@127.0.0.1:55439/assistant_dev",
  );
  const workspaces: string[] = [];
  async function cleanup() {
    for (const workspace of workspaces)
      await sql.begin(async (tx) => {
        await tx`DELETE FROM notification_deliveries WHERE intent_id IN (SELECT id FROM notification_intents WHERE workspace_id=${workspace})`;
        await tx`DELETE FROM notification_intents WHERE workspace_id=${workspace}`;
        await tx`DELETE FROM push_subscriptions WHERE workspace_id=${workspace}`;
        await tx`DELETE FROM browser_sessions WHERE credential_hash IN (SELECT token_hash FROM credentials WHERE workspace_id=${workspace})`;
        await tx`DELETE FROM responsibility_notifications WHERE workspace_id=${workspace}`;
        await tx`DELETE FROM responsibility_evaluations WHERE workspace_id=${workspace}`;
        await tx`DELETE FROM responsibilities WHERE workspace_id=${workspace}`;
        await tx`DELETE FROM outbox WHERE workspace_id=${workspace}`;
        await tx`DELETE FROM events WHERE workspace_id=${workspace}`;
        await tx`DELETE FROM notification_attention_messages WHERE run_id IN (SELECT id FROM runs WHERE workspace_id=${workspace})`;
        await tx`DELETE FROM message_artifacts WHERE workspace_id=${workspace}`;
        await tx`DELETE FROM artifacts WHERE workspace_id=${workspace}`;
        await tx`DELETE FROM messages WHERE workspace_id=${workspace}`;
        await tx`DELETE FROM runs WHERE workspace_id=${workspace}`;
        await tx`DELETE FROM daemon_sessions WHERE vm_id IN (SELECT id FROM vms WHERE workspace_id=${workspace})`;
        await tx`DELETE FROM tasks WHERE workspace_id=${workspace}`;
        await tx`DELETE FROM credentials WHERE workspace_id=${workspace}`;
        await tx`DELETE FROM conversations WHERE workspace_id=${workspace}`;
        await tx`DELETE FROM vms WHERE workspace_id=${workspace}`;
        await tx`DELETE FROM workspaces WHERE id=${workspace}`;
      });
    await sql.end();
  }
  async function fixture() {
    const workspace = crypto.randomUUID(),
      vm = crypto.randomUUID(),
      conversation = crypto.randomUUID(),
      task = crypto.randomUUID(),
      run = crypto.randomUUID(),
      installation = crypto.randomUUID();
    const client = crypto.randomUUID(),
      daemon = crypto.randomUUID(),
      credential = await hashToken(client);
    await sql`INSERT INTO workspaces(id,name) VALUES(${workspace},'native-notifications-fixture')`;
    workspaces.push(workspace);
    await sql`INSERT INTO credentials(token_hash,workspace_id,role) VALUES(${credential},${workspace},'client')`;
    await sql`INSERT INTO vms(id,workspace_id,name) VALUES(${vm},${workspace},'fixture')`;
    await sql`INSERT INTO credentials(token_hash,workspace_id,role,vm_id) VALUES(${await hashToken(daemon)},${workspace},'vm',${vm})`;
    await sql`INSERT INTO conversations(id,workspace_id,title) VALUES(${conversation},${workspace},'fixture')`;
    await sql`INSERT INTO tasks(id,workspace_id,conversation_id,objective,state) VALUES(${task},${workspace},${conversation},'fixture','running')`;
    await sql`INSERT INTO runs(id,workspace_id,task_id,vm_id,state) VALUES(${run},${workspace},${task},${vm},'running')`;
    const app = createApp(sql, { notificationConfig });
    const headers = { authorization: `Bearer ${client}`, "content-type": "application/json" };
    const event = {
      kind: "state",
      event_id: crypto.randomUUID(),
      run_id: run,
      state: "succeeded",
      reason: null,
    };
    const finishId = crypto.randomUUID();
    const post = (body: object) =>
      app.request("/v1/daemon/events", {
        method: "POST",
        headers: { authorization: `Bearer ${daemon}`, "content-type": "application/json" },
        body: JSON.stringify(body),
      });
    return {
      post,
      daemonPost: (path: string, body: object) =>
        app.request(path, { method: "POST", headers: { authorization: `Bearer ${daemon}`, "content-type": "application/json" }, body: JSON.stringify(body) }),
      daemonGet: (path: string) => app.request(path, { headers: { authorization: `Bearer ${daemon}` } }),
      poll: () =>
        app.request("/v1/daemon/poll", { headers: { authorization: `Bearer ${daemon}` } }),
      workspace,
      vm,
      task,
      run,
      credential,
      app,
      headers,
      installation,
      event,
      conversation,
      register: (token = "synthetic-token-original") =>
        app.request("/v1/notifications/subscription", {
          method: "PUT",
          headers,
          body: JSON.stringify({
            installation_id: installation,
            subscription: { transport: "fcm", platform: "ios", token },
          }),
        }),
      complete: async () => {
        if (event.state !== "succeeded") return post(event);
        const message = await post({
          kind: "message",
          event_id: event.event_id,
          run_id: run,
          content: "실제 답변이에요 👋",
        });
        if (message.status !== 200) return message;
        return post({ ...event, event_id: finishId });
      },
      deliveries: () =>
        sql`SELECT d.* FROM notification_deliveries d JOIN notification_intents n ON n.id=d.intent_id WHERE n.workspace_id=${workspace}`,
    };
  }

  return { sql, fixture, cleanup };
}
export const { sql, fixture, cleanup } = createNotificationFixtures();
