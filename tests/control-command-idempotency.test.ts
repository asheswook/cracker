import { expect, test } from "bun:test";
import { z } from "zod";
import { Command } from "../packages/protocol";
import { controlFixture } from "./control-fixture";

const { sql, workspace, alien, client, machine, vm, alienToken, request } = controlFixture();
const Response = z.object({ command: Command });
for (const status of ["applied", "failed"] as const)
  test(`client command ID replay preserves ${status} receipt and VM state`, async () => {
    // Given one durable client ID, including simultaneous retries of a lost response.
    const id = crypto.randomUUID();
    const body = { client_command_id: id, kind: "takeover" };
    const responses = await Promise.all(
      Array.from({ length: 4 }, () => request(`/v1/vms/${vm}/control`, client, body)),
    );
    for (const response of responses) {
      expect(response.status).toBe(200);
      expect(Response.parse(await response.json()).command.id).toBe(id);
    }
    expect(
      (
        await request("/v1/daemon/events", machine, {
          kind: "command_ack",
          event_id: crypto.randomUUID(),
          command_id: id,
          status,
          detail: "verified",
          resume_safe: false,
        })
      ).status,
    ).toBe(200);
    const before = (await sql`SELECT control_state FROM assistant.vms WHERE id=${vm}`)[0];
    // When the original ID is retried after its terminal ACK.
    const replay = await request(`/v1/vms/${vm}/control`, client, body);
    // Then it returns the same command and does not put the VM back into switching.
    expect(replay.status).toBe(200);
    expect(Response.parse(await replay.json()).command.id).toBe(id);
    expect((await sql`SELECT control_state FROM assistant.vms WHERE id=${vm}`)[0]).toEqual(before);
    expect(
      Number((await sql`SELECT count(*) FROM assistant.commands WHERE id=${id}`)[0]?.["count"]),
    ).toBe(1);
    const receipt = z
      .object({ command: Command.extend({ status: z.string(), acked_at: z.string() }) })
      .parse(await (await request(`/v1/commands/${id}`)).json());
    expect(receipt.command.status).toBe(status);
    await sql`UPDATE assistant.vms SET control_state='agent' WHERE id=${vm}`;
  });
test("same ID with different kind, VM or workspace conflicts without writes", async () => {
  // Given an existing command plus other owned/foreign VMs.
  const ownVm = crypto.randomUUID(),
    foreignVm = crypto.randomUUID(),
    id = crypto.randomUUID();
  await sql`INSERT INTO assistant.vms(id,workspace_id,name) VALUES(${ownVm},${workspace},'other'),(${foreignVm},${alien},'foreign')`;
  expect(
    (await request(`/v1/vms/${ownVm}/control`, client, { client_command_id: id, kind: "takeover" }))
      .status,
  ).toBe(200);
  // When reusing its key for a different intent or scope.
  expect(
    (
      await request(`/v1/vms/${ownVm}/control`, client, {
        client_command_id: id,
        kind: "return_control",
      })
    ).status,
  ).toBe(409);
  expect(
    (await request(`/v1/vms/${vm}/control`, client, { client_command_id: id, kind: "takeover" }))
      .status,
  ).toBe(409);
  expect(
    (
      await request(`/v1/vms/${foreignVm}/control`, alienToken, {
        client_command_id: id,
        kind: "takeover",
      })
    ).status,
  ).toBe(409);
  // Then only the original command exists and unrelated VM state remains unchanged.
  expect(
    Number((await sql`SELECT count(*) FROM assistant.commands WHERE id=${id}`)[0]?.["count"]),
  ).toBe(1);
  expect(
    (await sql`SELECT control_state FROM assistant.vms WHERE id=${vm}`)[0]?.["control_state"],
  ).toBe("agent");
  expect(
    (await sql`SELECT control_state FROM assistant.vms WHERE id=${foreignVm}`)[0]?.[
      "control_state"
    ],
  ).toBe("agent");
  expect((await request(`/v1/commands/${id}`, alienToken)).status).toBe(404);
});
test("a fresh client ID cannot alias an unrelated pending command", async () => {
  // Given one pending command on an otherwise independent VM.
  const target = crypto.randomUUID(),
    original = crypto.randomUUID(),
    other = crypto.randomUUID();
  await sql`INSERT INTO assistant.vms(id,workspace_id,name) VALUES(${target},${workspace},'pending')`;
  await request(`/v1/vms/${target}/control`, client, {
    client_command_id: original,
    kind: "takeover",
  });
  // When a new idempotency key requests the same kind while that command is pending.
  const conflict = await request(`/v1/vms/${target}/control`, client, {
    client_command_id: other,
    kind: "takeover",
  });
  // Then reject, leaving no misleading receipt under the new ID; legacy coalescing is unchanged.
  expect(conflict.status).toBe(409);
  expect(
    z.object({ error: z.object({ code: z.string() }) }).parse(await conflict.json()).error.code,
  ).toBe("switch_pending");
  expect((await request(`/v1/commands/${other}`)).status).toBe(404);
  const legacy = Response.parse(
    await (await request(`/v1/vms/${target}/control`, client, { kind: "takeover" })).json(),
  );
  expect(legacy.command.id).toBe(original);
});
test("concurrent same-ID requests on different VMs yield one receipt and a conflict", async () => {
  for (let attempt = 0; attempt < 40; attempt++) {
    // Given different VM locks and one colliding global command ID.
    const first = crypto.randomUUID(),
      second = crypto.randomUUID(),
      id = crypto.randomUUID();
    await sql`INSERT INTO assistant.vms(id,workspace_id,name) VALUES(${first},${workspace},'first'),(${second},${workspace},'second')`;
    // When the conflicting requests race past independent VM locks.
    const responses = await Promise.all(
      [first, second].map((target) =>
        request(`/v1/vms/${target}/control`, client, { client_command_id: id, kind: "takeover" }),
      ),
    );
    // Then the primary-key race is an explicit conflict, not an internal error or second effect.
    expect(responses.map((response) => response.status).sort()).toEqual([200, 409]);
    expect(
      Number((await sql`SELECT count(*) FROM assistant.commands WHERE id=${id}`)[0]?.["count"]),
    ).toBe(1);
    const states = z
      .array(z.object({ id: z.uuid(), control_state: z.string() }))
      .parse(
        await sql`SELECT id,control_state FROM assistant.vms WHERE id IN (${first},${second})`,
      );
    const winner = responses[0]?.status === 200 ? first : second;
    expect(states.find((vm) => vm.id === winner)?.control_state).toBe("switching");
    expect(states.find((vm) => vm.id !== winner)?.control_state).toBe("agent");
  }
});

test("terminal same-ID replay wins over a newer pending opposite command", async () => {
  // Given an applied takeover followed by a pending return-control request.
  const original = crypto.randomUUID(),
    newer = crypto.randomUUID();
  await request(`/v1/vms/${vm}/control`, client, { client_command_id: original, kind: "takeover" });
  expect(
    (
      await request("/v1/daemon/events", machine, {
        kind: "command_ack",
        event_id: crypto.randomUUID(),
        command_id: original,
        status: "applied",
        detail: "verified",
        resume_safe: false,
      })
    ).status,
  ).toBe(200);
  await request(`/v1/vms/${vm}/control`, client, {
    client_command_id: newer,
    kind: "return_control",
  });
  // When a lost old response causes replay of the original ID.
  const replay = await request(`/v1/vms/${vm}/control`, client, {
    client_command_id: original,
    kind: "takeover",
  });
  // Then it returns its original identity without conflicting with or replacing the newer intent.
  expect(replay.status).toBe(200);
  expect(Response.parse(await replay.json()).command.id).toBe(original);
  expect(
    (await sql`SELECT control_state FROM assistant.vms WHERE id=${vm}`)[0]?.["control_state"],
  ).toBe("switching");
  expect((await sql`SELECT status FROM assistant.commands WHERE id=${newer}`)[0]?.["status"]).toBe(
    "pending",
  );
  expect(
    Number(
      (await sql`SELECT count(*) FROM assistant.commands WHERE id IN (${original},${newer})`)[0]?.[
        "count"
      ],
    ),
  ).toBe(2);
  expect(
    (
      await request("/v1/daemon/events", machine, {
        kind: "command_ack",
        event_id: crypto.randomUUID(),
        command_id: newer,
        status: "applied",
        detail: "verified",
      })
    ).status,
  ).toBe(200);
});
