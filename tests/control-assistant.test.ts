import { expect, test } from "bun:test";
import { z } from "zod";
import { Conversation, DaemonPoll, Persona } from "../packages/protocol";
import { controlFixture } from "./control-fixture";
const f = controlFixture();
const Envelope = z.object({ conversation: Conversation });
const Settings = z.object({ instructions: z.string(), persona: Persona });
async function saveSettings(body: Record<string, unknown>) {
  const { revision } = z.object({ revision: z.uuid() }).parse(await (await f.request('/v1/settings')).json());
  return f.request('/v1/settings', f.client, { ...body, expected_revision: revision }, 'PUT');
}

test("ensure creates one new canonical conversation concurrently, preserves history and isolates workspaces", async () => {
  const legacy = await f.newConversation();
  expect(await (await f.request("/v1/assistant/conversation")).json()).toEqual({
    conversation: null,
  });
  const responses = await Promise.all(
    Array.from({ length: 8 }, () => f.request("/v1/assistant/conversation", f.client, {}, "POST")),
  );
  const ids = new Set<string>();
  for (const response of responses) {
    expect(response.status).toBe(200);
    ids.add(Envelope.parse(await response.json()).conversation.id);
  }
  expect(ids.size).toBe(1);
  expect(ids.has(legacy.id)).toBe(false);
  const current = Envelope.parse(
    await (await f.request("/v1/assistant/conversation")).json(),
  ).conversation;
  expect(ids.has(current.id)).toBe(true);
  const rows =
    await f.sql`SELECT id FROM assistant.conversations WHERE workspace_id=${f.workspace}`;
  expect(rows.length).toBe(2);
  expect(rows.some((row) => row["id"] === legacy.id)).toBe(true);
  const other = Envelope.parse(
    await (await f.request("/v1/assistant/conversation", f.alienToken, {}, "POST")).json(),
  ).conversation;
  expect(other.id).not.toBe(current.id);
  await expect(
    Promise.resolve(
      f.sql`UPDATE assistant.workspaces SET default_conversation_id=${other.id} WHERE id=${f.workspace}`,
    ),
  ).rejects.toMatchObject({ code: "23503" });
  expect((await f.request("/v1/assistant/conversation", f.machine)).status).toBe(403);
});

test("persona persists without clobbering legacy instructions and assignments/context include it", async () => {
  expect(Settings.parse(await (await f.request("/v1/settings")).json())).toEqual({
    instructions: "",
    persona: { name: "Assistant", role: "", style: "" },
  });
  const persona = { name: "동료", role: "개발 보조", style: "간결하게" };
  expect((await saveSettings({ persona })).status).toBe(200);
  const changed = Settings.parse(
    await (await saveSettings({ instructions: "Use Korean" })).json(),
  );
  expect(changed).toEqual({ instructions: "Use Korean", persona });
  const alien = Settings.parse(await (await f.request("/v1/settings", f.alienToken)).json());
  expect(alien.persona.name).toBe("Assistant");
  expect(alien.instructions).toBe("");
  await f.newTask();
  const poll = DaemonPoll.parse(await (await f.request("/v1/daemon/poll", f.machine)).json());
  expect(poll.assignment?.persona).toEqual(persona);
  expect(poll.assignment?.instructions).toBe("Use Korean");
  if (!poll.assignment) throw new TypeError("Expected assignment");
  const context = Settings.parse(
    await (await f.request(`/v1/daemon/context/${poll.assignment.run_id}`, f.machine)).json(),
  );
  expect(context).toEqual(changed);
  await f.finishActive();
});

test("settings reject invalid/partial persona and preserve stored values; empty role/style are valid", async () => {
  const before = Settings.parse(await (await f.request("/v1/settings")).json());
  for (const body of [
    {},
    { persona: { name: "  ", role: "", style: "" } },
    { persona: { name: "A" } },
    { persona: { name: "A", role: "x".repeat(2001), style: "" } },
    { persona: { name: "A", role: "", style: "", model: "override" } },
  ]) {
    expect((await saveSettings(body)).status).toBe(400);
  }
  expect(Settings.parse(await (await f.request("/v1/settings")).json())).toEqual(before);
  const cleared = Settings.parse(
    await (
      await saveSettings({ persona: { name: "  Assistant  ", role: "", style: "" } })
    ).json(),
  );
  expect(cleared.persona).toEqual({ name: "Assistant", role: "", style: "" });
  expect(cleared.instructions).toBe(before.instructions);
  expect((await f.request("/v1/settings", f.machine, { instructions: "x" }, "PUT")).status).toBe(
    403,
  );
});

test("completed work creates a new task in the same persistent feed and newer history cannot replace it", async () => {
  const canonical = Envelope.parse(
    await (await f.request("/v1/assistant/conversation")).json(),
  ).conversation;
  const Result = z.object({
    task: z.object({ id: z.uuid(), conversation_id: z.uuid() }),
    message: z.object({ id: z.uuid() }),
  });
  const first = Result.parse(
    await (
      await f.request(`/v1/conversations/${canonical.id}/messages`, f.client, {
        client_message_id: crypto.randomUUID(),
        content: "First work unit",
      })
    ).json(),
  );
  await f.finishActive();
  const second = Result.parse(
    await (
      await f.request(`/v1/conversations/${canonical.id}/messages`, f.client, {
        client_message_id: crypto.randomUUID(),
        content: "Next work unit",
      })
    ).json(),
  );
  expect(second.task.id).not.toBe(first.task.id);
  expect(second.task.conversation_id).toBe(first.task.conversation_id);
  const messages =
    await f.sql`SELECT id FROM assistant.messages WHERE conversation_id=${canonical.id} AND workspace_id=${f.workspace}`;
  expect(messages.some((row) => row["id"] === first.message.id)).toBe(true);
  expect(messages.some((row) => row["id"] === second.message.id)).toBe(true);
  await f.newConversation();
  const ensured = Envelope.parse(
    await (await f.request("/v1/assistant/conversation", f.client, {}, "POST")).json(),
  );
  expect(ensured.conversation.id).toBe(canonical.id);
  await f.finishActive();
});
