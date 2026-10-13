import { z } from "zod";
import { Command, DomainError, Id } from "../../../packages/protocol";
import type { Principal } from "../auth";
import type { Query } from "../db";
import { loadRun } from "./runs";

export const ComputerControlRequest = z.object({
  run_id: Id,
  request_id: Id,
  reason: z.string().trim().min(1).max(2000),
}).strict();
const StoredCommand = Command.extend({ run_id: Id.nullable(), status: z.string() });
const Receipt = z.object({
  workspace_id: Id, vm_id: Id, kind: z.literal("computer_control_requested"),
  payload: ComputerControlRequest.extend({ command_id: Id.nullable() }),
});

export async function requestComputerControl(sql: Query, principal: Principal, request: z.infer<typeof ComputerControlRequest>) {
  const vm = z.object({ control_state: z.string() }).parse((await sql`
    SELECT control_state FROM assistant.vms WHERE id=${principal.vm_id}
      AND workspace_id=${principal.workspace_id} FOR UPDATE`)[0]);
  const run = await loadRun(sql, principal, request.run_id);
  if (!["running", "waiting"].includes(run.state))
    throw new DomainError("stale_run", "Run cannot request computer control", 409);
  if (vm.control_state === "unknown")
    throw new DomainError("control_unavailable", "Computer control requires reconciliation", 409);
  const prior = await sql`SELECT workspace_id,vm_id,kind,payload FROM assistant.events WHERE event_id=${request.request_id}`;
  const receipt = prior[0] ? Receipt.safeParse(prior[0]) : null;
  if (receipt && (!receipt.success || receipt.data.workspace_id !== principal.workspace_id ||
      receipt.data.vm_id !== principal.vm_id || receipt.data.payload.run_id !== run.id ||
      receipt.data.payload.reason !== request.reason))
    throw new DomainError("idempotency_conflict", "Computer control request ID reused", 409);
  const pending = z.array(StoredCommand).parse(await sql`
    SELECT * FROM assistant.commands WHERE vm_id=${principal.vm_id}
      AND workspace_id=${principal.workspace_id} AND status='pending' ORDER BY created_at`);
  if (pending.some(command => command.kind !== "return_control" || (command.run_id !== null && command.run_id !== run.id)))
    throw new DomainError("command_pending", "Apply pending commands before requesting computer control", 409);
  if ((await sql`SELECT vm_id FROM assistant.chatgpt_accounts WHERE vm_id=${principal.vm_id} AND request_status IN ('pending','running') AND lease_until>now()`).length)
    throw new DomainError("command_pending", "Account connection is being changed", 409);
  if (receipt?.success) {
    const command = pending.find(item => item.id === receipt.data.payload.command_id);
    if (command && vm.control_state === "switching") return { control_state: "switching" as const, command: Command.parse(command) };
    if (vm.control_state === "agent" && !pending.length) return { control_state: "agent" as const, command: null };
    throw new DomainError("stale_request", "Create a new request for the current computer ownership", 409);
  }
  let command = pending[0] ? Command.parse(pending[0]) : null;
  switch (vm.control_state) {
    case "agent":
      if (command) throw new DomainError("command_pending", "Apply pending computer control command", 409);
      break;
    case "switching":
      if (!command) throw new DomainError("control_unavailable", "Computer ownership is switching", 409);
      break;
    case "user":
      if (!command) command = Command.parse((await sql`
        INSERT INTO assistant.commands(id,workspace_id,vm_id,task_id,run_id,kind,detail)
        VALUES(${request.request_id},${principal.workspace_id},${principal.vm_id},${run.task_id},${run.id},'return_control',${request.reason}) RETURNING *`)[0]);
      await sql`UPDATE assistant.vms SET control_state='switching' WHERE id=${principal.vm_id}`;
      break;
    default:
      throw new DomainError("control_unavailable", "Computer ownership is unavailable", 409);
  }
  await sql`INSERT INTO assistant.events(workspace_id,vm_id,event_id,kind,payload)
    VALUES(${principal.workspace_id},${principal.vm_id},${request.request_id},'computer_control_requested',${JSON.stringify({ ...request, command_id: command?.id ?? null })}::text::jsonb)`;
  return { control_state: command ? "switching" as const : "agent" as const, command };
}
