import { expect, test } from "bun:test";
import { z } from "zod";
import { Command, DaemonPoll } from "../packages/protocol";
import { hashToken } from "../services/control/auth";
import { poll } from "../services/control/repository/runs";
import { controlFixture } from "./control-fixture";

const { sql, workspace, vm, client, machine, alien, request, newTask, finishActive } =
  controlFixture();
test("combined VM heartbeat lock claims full assignment and updates last_seen", async () => {
  // Given queued work and an old heartbeat.
  await finishActive();
  const initial = await newTask();
  await sql`UPDATE assistant.vms SET last_seen_at='2000-01-01T00:00:00Z',control_state='agent' WHERE id=${vm}`;
  // When polling under the combined lock/write query.
  const polled = DaemonPoll.parse(await (await request("/v1/daemon/poll", machine)).json());
  // Then assignment context and heartbeat remain complete.
  expect(polled.assignment?.task.id).toBe(initial.task.id);
  expect(polled.assignment?.messages).toHaveLength(1);
  const seen = z
    .object({ last_seen_at: z.string() })
    .parse((await sql`SELECT last_seen_at FROM assistant.vms WHERE id=${vm}`)[0]);
  expect(Date.parse(seen.last_seen_at)).toBeGreaterThan(Date.parse("2000-01-01"));
});
for (const state of ["paused", "unknown"] as const)
  test(`combined VM lock preserves ${state} quarantine`, async () => {
    // Given an existing non-runnable run and more queued work.
    await finishActive();
    await newTask();
    const assigned = DaemonPoll.parse(
      await (await request("/v1/daemon/poll", machine)).json(),
    ).assignment;
    if (!assigned) throw new Error("Missing assignment");
    await sql`UPDATE assistant.runs SET state=${state} WHERE id=${assigned.run_id}`;
    await sql`UPDATE assistant.tasks SET state=${state} WHERE id=${assigned.task.id}`;
    const queued = await newTask();
    // When polling with a mismatched run id in commands-only mode.
    const polled = DaemonPoll.parse(
      await (
        await request(`/v1/daemon/poll?view=commands&run_id=${crypto.randomUUID()}`, machine)
      ).json(),
    );
    // Then no replay or new assignment occurs and the original state stays unchanged.
    expect(polled.assignment).toBeNull();
    expect(polled.messages).toEqual([]);
    expect(
      (await sql`SELECT state FROM assistant.runs WHERE id=${assigned.run_id}`)[0]?.["state"],
    ).toBe(state);
    expect(
      (await sql`SELECT state FROM assistant.tasks WHERE id=${queued.task.id}`)[0]?.["state"],
    ).toBe("queued");
  });
test("pending control commands take precedence over queued work", async () => {
  // Given queued work and a pending takeover.
  await finishActive();
  await sql`UPDATE assistant.vms SET control_state='agent' WHERE id=${vm}`;
  const queued = await newTask();
  const command = z
    .object({ command: Command })
    .parse(
      await (await request(`/v1/vms/${vm}/control`, client, { kind: "takeover" })).json(),
    ).command;
  // When polling idle, even if an external writer left the VM marked agent.
  await sql`UPDATE assistant.vms SET control_state='agent' WHERE id=${vm}`;
  const polled = DaemonPoll.parse(await (await request("/v1/daemon/poll", machine)).json());
  // Then command priority prevents a claim independently of switching state.
  expect(polled.commands.map((item) => item.id)).toContain(command.id);
  expect(polled.assignment).toBeNull();
  expect(
    (await sql`SELECT state FROM assistant.tasks WHERE id=${queued.task.id}`)[0]?.["state"],
  ).toBe("queued");
  await request("/v1/daemon/events", machine, {
    kind: "command_ack",
    event_id: crypto.randomUUID(),
    command_id: command.id,
    status: "failed",
    detail: "fixture completion",
  });
  await sql`UPDATE assistant.vms SET control_state='agent' WHERE id=${vm}`;
});
test("other workspace polling cannot heartbeat or claim the original VM", async () => {
  // Given a separately authenticated VM and original VM's fixed heartbeat.
  await finishActive();
  const queued = await newTask();
  const foreignVM = crypto.randomUUID(),
    token = crypto.randomUUID() + crypto.randomUUID();
  await sql`INSERT INTO assistant.vms(id,workspace_id,name) VALUES(${foreignVM},${alien},'foreign-poller')`;
  await sql`INSERT INTO assistant.credentials(token_hash,workspace_id,role,vm_id) VALUES(${await hashToken(token)},${alien},'vm',${foreignVM})`;
  await sql`UPDATE assistant.vms SET last_seen_at='2000-01-01T00:00:00Z' WHERE id=${vm}`;
  // When the foreign principal polls normally.
  const polled = DaemonPoll.parse(await (await request("/v1/daemon/poll", token)).json());
  // Then it neither claims the original task nor modifies the original VM heartbeat.
  expect(polled.assignment).toBeNull();
  expect(
    (await sql`SELECT state FROM assistant.tasks WHERE id=${queued.task.id}`)[0]?.["state"],
  ).toBe("queued");
  const seen = z
    .object({ last_seen_at: z.string() })
    .parse((await sql`SELECT last_seen_at FROM assistant.vms WHERE id=${vm}`)[0]);
  expect(Date.parse(seen.last_seen_at)).toBe(Date.parse("2000-01-01"));
});

test("combined heartbeat retains FOR UPDATE lock strength until commit", async () => {
  // Given one transaction executing the production poll under its VM lock.
  await finishActive();
  await sql.begin(async (tx) => {
    await poll(tx, { workspace_id: workspace, vm_id: vm, role: "vm" }, undefined, "commands");
    // When a different connection attempts a KEY SHARE row lock without waiting.
    let conflict: string | undefined;
    try {
      await sql.begin(
        (other) => other`SELECT id FROM assistant.vms WHERE id=${vm} FOR KEY SHARE NOWAIT`,
      );
    } catch (error) {
      if (error instanceof Error && "code" in error && typeof error.code === "string")
        conflict = error.code;
      else throw error;
    }
    // Then the retained FOR UPDATE lock conflicts, unlike a plain non-key UPDATE lock.
    expect(conflict).toBe("55P03");
  });
});
