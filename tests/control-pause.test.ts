import { expect, test } from "bun:test";
import { z } from "zod";
import { Command, DaemonPoll } from "../packages/protocol";
import { controlFixture } from "./control-fixture";

const { sql, vm, client, machine, request, newTask, finishActive } = controlFixture();
async function active() {
  await finishActive();
  const original = await newTask();
  const polled = DaemonPoll.parse(await (await request("/v1/daemon/poll", machine)).json());
  if (!polled.assignment) throw new Error("Assignment missing");
  return { task: original.task.id, run: polled.assignment.run_id };
}
async function control(kind: "takeover" | "return_control") {
  const result = await request(`/v1/vms/${vm}/control`, client, { kind });
  expect(result.status).toBe(200);
  return z.object({ command: Command }).parse(await result.json()).command;
}
async function ack(command: z.infer<typeof Command>) {
  return request("/v1/daemon/events", machine, {
    kind: "command_ack",
    event_id: crypto.randomUUID(),
    command_id: command.id,
    ...(command.kind === "takeover" ? { resume_safe: true } : {}),
    status: "applied",
    detail: "local barrier complete",
  });
}
async function state(task: string) {
  return z
    .object({ state: z.string() })
    .parse((await sql`SELECT state FROM assistant.tasks WHERE id=${task}`)[0]).state;
}

test("preserves intentional pause across idle polls and resumes with a fresh run", async () => {
  // Given a claimed run paused by a verified takeover ACK.
  const original = await active();
  expect((await ack(await control("takeover"))).status).toBe(200);
  // When multiple idle polls omit the intentionally ended local run journal.
  await request("/v1/daemon/poll", machine);
  await request("/v1/daemon/poll", machine);
  // Then task remains paused and explicit return obtains a fresh run.
  expect(await state(original.task)).toBe("paused");
  expect((await ack(await control("return_control"))).status).toBe(200);
  const resumed = DaemonPoll.parse(await (await request("/v1/daemon/poll", machine)).json());
  expect(resumed.assignment?.task.id).toBe(original.task);
  expect(resumed.assignment?.run_id).not.toBe(original.run);
});

test("accepts recovery unknown receipt without clearing an existing quarantine reason", async () => {
  // Given a run already quarantined by control before daemon recovery.
  const original = await active();
  await sql`UPDATE assistant.runs SET state='unknown' WHERE id=${original.run}`;
  await sql`UPDATE assistant.tasks SET state='unknown',reason='heartbeat expired' WHERE id=${original.task}`;
  // When daemon recovery sends its durable unknown event, including an exact retry.
  const event = {
    kind: "state",
    event_id: crypto.randomUUID(),
    run_id: original.run,
    state: "unknown",
    reason: "daemon restarted",
  };
  expect((await request("/v1/daemon/events", machine, event)).status).toBe(200);
  expect((await request("/v1/daemon/events", machine, event)).status).toBe(200);
  // Then existing quarantine remains and no new assignment is made.
  expect(
    z
      .object({ state: z.string(), reason: z.string() })
      .parse((await sql`SELECT state,reason FROM assistant.tasks WHERE id=${original.task}`)[0]),
  ).toEqual({ state: "unknown", reason: "heartbeat expired" });
  expect(
    DaemonPoll.parse(await (await request("/v1/daemon/poll", machine)).json()).assignment,
  ).toBeNull();
});

test("return-control ACK preserves a cancelling run until its stop ACK arrives", async () => {
  // Given paused task, then return request followed by stop request before daemon processes either.
  const original = await active();
  expect((await ack(await control("takeover"))).status).toBe(200);
  const returned = await control("return_control");
  const stopped = z
    .object({ command: Command })
    .parse(await (await request(`/v1/tasks/${original.task}/stop`, client, {})).json()).command;
  // When ACKs arrive in their command order.
  expect((await ack(returned)).status).toBe(200);
  expect((await ack(stopped)).status).toBe(200);
  // Then cancellation completes; no terminal-run stale-ACK poison remains.
  expect(await state(original.task)).toBe("cancelled");
  expect(
    z
      .object({ state: z.string() })
      .parse((await sql`SELECT state FROM assistant.runs WHERE id=${original.run}`)[0]).state,
  ).toBe("cancelled");
});

test("takeover and return never replay an unknown run without reconciliation", async () => {
  // Given a quarantined run with uncertain external effects.
  const original = await active();
  await sql`UPDATE assistant.runs SET state='unknown' WHERE id=${original.run}`;
  await sql`UPDATE assistant.tasks SET state='unknown' WHERE id=${original.task}`;
  // When user takes control and returns it.
  expect((await ack(await control("takeover"))).status).toBe(200);
  expect((await ack(await control("return_control"))).status).toBe(200);
  // Then the unknown task remains quarantined and no replacement run is claimed.
  expect(await state(original.task)).toBe("unknown");
  expect(
    DaemonPoll.parse(await (await request("/v1/daemon/poll", machine)).json()).assignment,
  ).toBeNull();
});

test.each([undefined, false])(
  "takeover without safe-resume proof quarantines work (%s)",
  async (resumeSafe) => {
    // Given a running task whose takeover ACK cannot prove safe resumption.
    const original = await active();
    const takeover = await control("takeover");
    // When older or uncertain daemon acknowledges ownership transfer.
    const response = await request("/v1/daemon/events", machine, {
      kind: "command_ack",
      event_id: crypto.randomUUID(),
      command_id: takeover.id,
      status: "applied",
      detail: "execution aborted",
      ...(resumeSafe === undefined ? {} : { resume_safe: resumeSafe }),
    });
    // Then control transfer succeeds but neither return nor idle poll can replay the task.
    expect(response.status).toBe(200);
    expect(await state(original.task)).toBe("unknown");
    expect((await ack(await control("return_control"))).status).toBe(200);
    expect(
      DaemonPoll.parse(await (await request("/v1/daemon/poll", machine)).json()).assignment,
    ).toBeNull();
    expect(await state(original.task)).toBe("unknown");
  },
);
