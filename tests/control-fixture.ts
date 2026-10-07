import { afterAll, beforeAll, expect } from "bun:test";
import { z } from "zod";
import { Conversation, Message, Task } from "../packages/protocol";
import { createApp } from "../services/control/app";
import { hashToken } from "../services/control/auth";
import { createDatabase } from "../services/control/db";
export function controlFixture() {
  const url =
    process.env["TEST_DATABASE_URL"] ?? "postgres://assistant:assistant@127.0.0.1:55439/assistant_dev";
  const sql = createDatabase(url);
  const app = createApp(sql);
  const workspace = crypto.randomUUID(),
    vm = crypto.randomUUID(),
    client = crypto.randomUUID() + crypto.randomUUID(),
    machine = crypto.randomUUID() + crypto.randomUUID();
  const alien = crypto.randomUUID(),
    alienToken = crypto.randomUUID() + crypto.randomUUID();
  async function request(path: string, token = client, body?: unknown, method?: string) {
    return app.request(path, {
      method: method ?? (body ? "POST" : "GET"),
      headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
      ...(body ? { body: JSON.stringify(body) } : {}),
    });
  }
  async function newConversation() {
    const r = await request("/v1/conversations", client, { title: "test" });
    expect(r.status).toBe(201);
    return Conversation.parse(
      z.object({ conversation: Conversation }).parse(await r.json()).conversation,
    );
  }
  async function newTask() {
    const c = await newConversation();
    const response = await request(`/v1/conversations/${c.id}/messages`, client, {
      client_message_id: crypto.randomUUID(),
      content: "objective",
    });
    return z.object({ task: Task, message: Message }).parse(await response.json());
  }
  async function finishActive() {
    const runs =
      await sql`SELECT id FROM assistant.runs WHERE vm_id=${vm} AND state NOT IN ('cancelled','succeeded','failed')`;
    for (const row of runs) {
      const id = z.object({ id: z.uuid() }).parse(row).id;
      await sql`UPDATE assistant.runs SET state='succeeded' WHERE id=${id}`;
    }
    await sql`UPDATE assistant.tasks SET state='succeeded' WHERE workspace_id=${workspace} AND state NOT IN ('cancelled','succeeded','failed')`;
  }
  beforeAll(async () => {
    const migration = Bun.spawn(["bun", "scripts/migrate.ts"], {
      env: { ...process.env, DATABASE_URL: url },
      stdout: "ignore",
      stderr: "ignore",
    });
    expect(await migration.exited).toBe(0);
    await sql`INSERT INTO workspaces(id,name) VALUES(${workspace},'test'),(${alien},'alien')`;
    await sql`INSERT INTO vms(id,workspace_id,name) VALUES(${vm},${workspace},'test-vm')`;
    await sql`INSERT INTO credentials(token_hash,workspace_id,role,vm_id) VALUES(${await hashToken(client)},${workspace},'client',null),(${await hashToken(machine)},${workspace},'vm',${vm}),(${await hashToken(alienToken)},${alien},'client',null)`;
  });
  afterAll(async () => {
    await finishActive();
    await sql.end();
  });
  return {
    sql,
    app,
    workspace,
    vm,
    client,
    machine,
    alien,
    alienToken,
    request,
    newConversation,
    newTask,
    finishActive,
  };
}
