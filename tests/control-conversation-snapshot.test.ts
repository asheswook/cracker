import { expect, spyOn, test } from "bun:test";
import { z } from "zod";
import { DaemonPoll, Message, ReadReceipt } from "../packages/protocol";
import { ComposingReceipt, ComposingState } from "../packages/protocol/composing";
import * as common from "../services/control/repository/common";
import { controlFixture } from "./control-fixture";

const f = controlFixture();
const Page = z.object({
  messages: z.array(Message),
  composing: ComposingState.nullable(),
  working: z.object({ run_id: z.uuid(), input_message_id: z.uuid() }).nullable(),
  cursor: z.number(),
  receipts: z.array(ReadReceipt),
});

async function setup(applied = true) {
  await f.finishActive();
  const task = await f.newTask();
  const assignment = DaemonPoll.parse(
    await (await f.request("/v1/daemon/poll", f.machine)).json(),
  ).assignment;
  if (!assignment) throw new TypeError("Missing assignment");
  const run = assignment.run_id;
  const apply = async () => {
    const response = await f.request("/v1/daemon/events", f.machine, {
      kind: "input_applied",
      run_id: run,
      event_id: crypto.randomUUID(),
      message_id: task.message.id,
    });
    expect(response.status).toBe(200);
  };
  if (applied) await apply();
  return { task, run, apply, path: `/v1/conversations/${task.message.conversation_id}/messages` };
}

async function readAcrossCommit(path: string, commit: () => Promise<void>) {
  const selected = Promise.withResolvers<void>();
  const resume = Promise.withResolvers<void>();
  const original = common.messages;
  const read = spyOn(common, "messages").mockImplementation(async (...args) => {
    const rows = await original(...args);
    selected.resolve();
    await resume.promise;
    return rows;
  });
  const server = Bun.serve({ port: 0, hostname: "127.0.0.1", fetch: f.app.fetch });
  const response = fetch(new URL(path, server.url), {
    headers: { Authorization: `Bearer ${f.client}` },
  });
  let timeout: ReturnType<typeof setTimeout> | undefined;
  const deadline = new Promise<never>((_, reject) => {
    timeout = setTimeout(() => reject(new TypeError("Snapshot scenario exceeded 3 seconds")), 3000);
  });
  try {
    await Promise.race([selected.promise, deadline]);
    await Promise.race([commit(), deadline]);
    resume.resolve();
    const result = await Promise.race([response, deadline]);
    expect(result.status).toBe(200);
    expect(result.headers.get("Cache-Control")).toBe("no-store");
    return Page.parse(await result.json());
  } finally {
    resume.resolve();
    clearTimeout(timeout);
    read.mockRestore();
    await response;
    await server.stop(true);
  }
}

test("message page preserves composing when reply commits after its message SELECT", async () => {
  // Given
  const s = await setup();
  const inference = crypto.randomUUID();
  const begun = await f.request("/v1/daemon/composing", f.machine, {
    kind: "begin",
    run_id: s.run,
    inference_id: inference,
    input_message_ids: [s.task.message.id],
  });
  expect(begun.status).toBe(200);
  const { generation } = ComposingReceipt.parse(await begun.json());
  const updated = await f.request("/v1/daemon/composing", f.machine, {
    kind: "update",
    run_id: s.run,
    inference_id: inference,
    generation,
    sequence: 1,
    status: "composing",
    response_id: "response",
    item_id: "reply",
    occurred_at: new Date().toISOString(),
  });
  expect(updated.status).toBe(200);
  expect(Page.parse(await (await f.request(s.path)).json()).composing?.inference_id).toBe(
    inference,
  );
  // When: the real daemon transaction inserts its reply and clears composing between the page's SELECTs.
  const page = await readAcrossCommit(`${s.path}?after=${s.task.message.sequence}`, async () => {
    const response = await f.request("/v1/daemon/events", f.machine, {
      kind: "message",
      run_id: s.run,
      event_id: crypto.randomUUID(),
      content: "Committed reply",
    });
    expect(response.status).toBe(200);
  });
  // Then: this page sees the old coherent state; the next page sees the committed reply.
  console.info(
    JSON.stringify({
      scenario: "reply-handoff",
      messages: page.messages.length,
      composing: page.composing !== null,
    }),
  );
  expect(page.messages).toEqual([]);
  expect(page.composing?.inference_id).toBe(inference);
  expect(page.cursor).toBe(s.task.message.sequence);
  const next = Page.parse(await (await f.request(`${s.path}?after=${page.cursor}`)).json());
  expect(next.messages.map((message) => message.content)).toEqual(["Committed reply"]);
  expect(next.composing).toBeNull();
});

test("message page keeps working and receipts at the message SELECT snapshot", async () => {
  // Given
  const s = await setup(false);
  // When: input application commits after the message and its embedded read_at were selected.
  const page = await readAcrossCommit(`${s.path}?receipt_ids=${s.task.message.id}`, s.apply);
  // Then: neither the receipt overlay nor working may claim this unread input was applied yet.
  console.info(
    JSON.stringify({
      scenario: "input-applied",
      read_at: page.messages[0]?.read_at,
      receipts: page.receipts.length,
      working: page.working !== null,
    }),
  );
  expect(page.messages[0]?.read_at).toBeNull();
  expect(page.receipts).toEqual([]);
  expect(page.working).toBeNull();
  const next = Page.parse(
    await (await f.request(`${s.path}?receipt_ids=${s.task.message.id}`)).json(),
  );
  expect(next.receipts.map((receipt) => receipt.message_id)).toEqual([s.task.message.id]);
  expect(next.messages[0]?.read_at).toBe(next.receipts[0]?.read_at);
  expect(next.working?.input_message_id).toBe(s.task.message.id);
});

test("message page denies another workspace and unknown conversations", async () => {
  // Given
  const s = await setup();
  // When
  const [alien, missing] = await Promise.all([
    f.request(s.path, f.alienToken),
    f.request(`/v1/conversations/${crypto.randomUUID()}/messages`),
  ]);
  // Then
  expect(alien.status).toBe(404);
  expect(missing.status).toBe(404);
});

test("message page excludes receipt IDs belonging to another conversation", async () => {
  // Given
  const first = await setup();
  const second = await setup();
  // When
  const response = await f.request(
    `${second.path}?after=${second.task.message.sequence}&receipt_ids=${first.task.message.id},${second.task.message.id}`,
  );
  // Then
  expect(response.status).toBe(200);
  const page = Page.parse(await response.json());
  expect(page.messages).toEqual([]);
  expect(page.cursor).toBe(second.task.message.sequence);
  expect(page.receipts.map((receipt) => receipt.message_id)).toEqual([second.task.message.id]);
});

for (const query of ["after=-1", "receipt_ids=invalid"]) {
  test(`message page rejects invalid ${query}`, async () => {
    // Given
    const conversation = await f.newConversation();
    // When
    const response = await f.request(`/v1/conversations/${conversation.id}/messages?${query}`);
    // Then
    expect(response.status).toBe(400);
  });
}
