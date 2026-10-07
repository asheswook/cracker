import { expect, test } from "bun:test";
import { z } from "zod";
import { DaemonPoll, Message } from "../packages/protocol";
import { controlFixture } from "./control-fixture";

const fixture = controlFixture();
test("mailbox returns new steering messages without repeating the workspace context", async () => {
  const initial = await fixture.newTask();
  const assignment = DaemonPoll.parse(
    await (await fixture.request("/v1/daemon/poll", fixture.machine)).json(),
  ).assignment;
  if (!assignment) throw new Error("Assignment missing");
  const content = `steering-${crypto.randomUUID()}`;
  await fixture.request(
    `/v1/conversations/${initial.task.conversation_id}/messages`,
    fixture.client,
    { client_message_id: crypto.randomUUID(), content },
  );
  const response = await fixture.request(
    `/v1/daemon/context/${assignment.run_id}?view=mailbox&after=${initial.message.sequence}`,
    fixture.machine,
  );
  const result = z
    .object({ messages: z.array(Message) })
    .strict()
    .parse(await response.json());
  expect(response.status).toBe(200);
  expect(result.messages.map((message) => message.content)).toEqual([content]);
});

test("mailbox rejects another VM in the same workspace", async () => {
  await fixture.finishActive();
  await fixture.newTask();
  const assignment = DaemonPoll.parse(
    await (await fixture.request("/v1/daemon/poll", fixture.machine)).json(),
  ).assignment;
  if (!assignment) throw new Error("Assignment missing");
  const { hashToken } = await import("../services/control/auth");
  const vm = crypto.randomUUID(),
    token = crypto.randomUUID();
  await fixture.sql`INSERT INTO assistant.vms(id,workspace_id,name) VALUES(${vm},${fixture.workspace},'other-vm')`;
  await fixture.sql`INSERT INTO assistant.credentials(token_hash,workspace_id,role,vm_id) VALUES(${await hashToken(token)},${fixture.workspace},'vm',${vm})`;
  const response = await fixture.request(
    `/v1/daemon/context/${assignment.run_id}?view=mailbox`,
    token,
  );
  expect(response.status).toBe(404);
});
