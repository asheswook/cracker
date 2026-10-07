import { afterAll, expect, test } from "bun:test";
import { z } from "zod";
import { createNotificationFixtures } from "./native-notifications-fixture.ts";
import { quarantineStaleRuns } from "../services/control/repository/recovery.ts";

const { sql, fixture, cleanup } = createNotificationFixtures();
const workspaces: string[] = [];
afterAll(async () => {
  for (const workspace of workspaces) await sql`DELETE FROM commands WHERE workspace_id=${workspace}`;
  await cleanup();
});

for (const scenario of [
  { kind: "stop", state: "cancelling", status: "failed" },
  ...["running", "waiting", "pausing", "paused"].map(state => ({ kind: "takeover", state, status: "applied" })),
]) {
  test(`${scenario.kind} ACK from ${scenario.state} publishes one unknown message and exact intent`, async () => {
    const f = await fixture();
    workspaces.push(f.workspace);
    await f.register();
    await sql`UPDATE tasks SET state=${scenario.state} WHERE id=${f.task}`;
    await sql`UPDATE runs SET state=${scenario.state} WHERE id=${f.run}`;
    const command = crypto.randomUUID();
    await sql`INSERT INTO commands(id,workspace_id,vm_id,task_id,run_id,kind) VALUES(${command},${f.workspace},${f.vm},${f.task},${f.run},${scenario.kind})`;
    const event = { kind: "command_ack", event_id: crypto.randomUUID(), command_id: command, status: scenario.status, resume_safe: false, detail: "synthetic ACK uncertainty" };
    expect((await f.post(event)).status).toBe(200);
    expect((await sql`SELECT state FROM runs WHERE id=${f.run}`)[0]?.["state"]).toBe("unknown");
    expect((await sql`SELECT state FROM tasks WHERE id=${f.task}`)[0]?.["state"]).toBe("unknown");
    const messages = z.array(z.object({ id: z.uuid(), role: z.string(), task_id: z.uuid().nullable(), content: z.string() })).parse(await sql`SELECT id,role,task_id,content FROM messages WHERE workspace_id=${f.workspace}`);
    expect(messages).toHaveLength(1);
    const message = messages[0];
    expect(message).toMatchObject({ role: "system", task_id: null, content: scenario.kind === "stop" ? "synthetic ACK uncertainty" : "Takeover interrupted actions without safe-resume proof; reconcile local journal" });
    const visible = await f.app.request(`/v1/conversations/${f.conversation}/messages`, { headers: f.headers });
    expect(visible.status).toBe(200);
    expect(await visible.json()).toMatchObject({ messages: [message] });
    expect(Array.from(await sql`SELECT message_id,run_id,outcome FROM notification_intents WHERE workspace_id=${f.workspace}`)).toEqual([{ message_id: message?.id, run_id: f.run, outcome: "message" }]);
    const deliveries = await f.deliveries();
    expect(deliveries).toHaveLength(1);
    expect(deliveries[0]).toMatchObject({ intent_id: message?.id, state: "pending", attempts: 0 });
    await sql`UPDATE notification_deliveries SET state='accepted',accepted_at=now() WHERE intent_id=${message?.id ?? ""}`;
    expect((await f.post(event)).status).toBe(200);
    expect((await f.post({ ...event, event_id: crypto.randomUUID() })).status).toBe(409);
    expect(await (await f.poll()).json()).toMatchObject({ assignment: null, messages: [] });
    await quarantineStaleRuns(sql);
    expect(await sql`SELECT id FROM messages WHERE workspace_id=${f.workspace}`).toHaveLength(1);
    expect(await f.deliveries()).toHaveLength(1);
    expect((await f.deliveries())[0]).toMatchObject({ intent_id: message?.id, state: "accepted", attempts: 0 });
  });
}

for (const scenario of [
  { kind: "stop", before: "cancelling", safe: false, after: "cancelled" },
  { kind: "takeover", before: "running", safe: true, after: "paused" },
  ...["cancelled", "succeeded", "failed", "cancelling"].map(state => ({ kind: "takeover", before: state, safe: false, after: state })),
]) {
  test(`${scenario.kind} ACK leaves ${scenario.after} without an attention notification`, async () => {
    const f = await fixture();
    workspaces.push(f.workspace);
    await f.register();
    await sql`UPDATE tasks SET state=${scenario.before} WHERE id=${f.task}`;
    await sql`UPDATE runs SET state=${scenario.before} WHERE id=${f.run}`;
    const command = crypto.randomUUID();
    await sql`INSERT INTO commands(id,workspace_id,vm_id,task_id,run_id,kind) VALUES(${command},${f.workspace},${f.vm},${f.task},${scenario.kind === "stop" ? f.run : null},${scenario.kind})`;
    expect((await f.post({ kind: "command_ack", event_id: crypto.randomUUID(), command_id: command, status: "applied", resume_safe: scenario.safe, detail: "synthetic acknowledgement" })).status).toBe(200);
    expect((await sql`SELECT state FROM runs WHERE id=${f.run}`)[0]?.["state"]).toBe(scenario.after);
    expect(await sql`SELECT id FROM messages WHERE workspace_id=${f.workspace}`).toHaveLength(0);
    expect(await f.deliveries()).toHaveLength(0);
  });
}
