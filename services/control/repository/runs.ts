import { z } from "zod";
import { taskSkill } from "../../../packages/extensions/versions.ts";
import { retrieveMemory } from "../../../packages/memory/persist";
import { pinRunModel, runModelBinding } from "../../../packages/models/repository.ts";
import { publishAttentionMessage } from "../../../packages/notifications/attention.ts";
import { Assignment, Command, DomainError, Persona, Task } from "../../../packages/protocol";
import type { Principal } from "../auth";
import type { Query } from "../db";
import { messages } from "./common";
import { workContext } from "./task-context";
import { validationRecoveryInput } from "./validation-recovery";
export const Run = z.object({
  id: z.uuid(),
  task_id: z.uuid(),
  vm_id: z.uuid(),
  state: z.string(),
});
export async function loadRun(sql: Query, principal: Principal, id: string) {
  const rows =
    await sql`SELECT * FROM assistant.runs WHERE id=${id} AND workspace_id=${principal.workspace_id} AND vm_id=${principal.vm_id} FOR UPDATE`;
  if (!rows[0]) throw new DomainError("not_found", "Run not found", 404);
  return Run.parse(rows[0]);
}
export async function context(sql: Query, principal: Principal, id: string, after = 0) {
  const run = await loadRun(sql, principal, id);
  const rows = await sql`SELECT * FROM assistant.tasks WHERE id=${run.task_id}`;
  const task = Task.parse(rows[0]);
  const workspace = z
    .object({ instructions: z.string(), persona: Persona })
    .parse(
      (
        await sql`SELECT instructions,json_build_object('name',persona_name,'role',persona_role,'style',persona_style) AS persona FROM assistant.workspaces WHERE id=${principal.workspace_id}`
      )[0],
    );
  const memory = await retrieveMemory(sql, principal.workspace_id, task.conversation_id);
  return Assignment.parse({
    model_binding: await runModelBinding(sql, principal, run.id),
    skill_binding: await taskSkill(sql, principal.workspace_id, task.id),
    task,
    run_id: run.id,
    messages: await messages(sql, principal.workspace_id, task.conversation_id, after),
    instructions: workspace.instructions,
    persona: workspace.persona,
    memory,
  });
}
export async function mailbox(
  sql: Query,
  principal: Principal,
  cursor: { readonly runId: string; readonly after: number },
) {
  const rows =
    await sql`SELECT t.conversation_id FROM assistant.runs r JOIN assistant.tasks t ON t.id=r.task_id AND t.workspace_id=r.workspace_id WHERE r.id=${cursor.runId} AND r.workspace_id=${principal.workspace_id} AND r.vm_id=${principal.vm_id} FOR UPDATE OF r`;
  if (!rows[0]) throw new DomainError("not_found", "Run not found", 404);
  const task = z.object({ conversation_id: z.uuid() }).parse(rows[0]);
  return {
    messages: await messages(sql, principal.workspace_id, task.conversation_id, cursor.after),
  };
}
export async function poll(
  sql: Query,
  principal: Principal,
  runId: string | undefined,
  view: "full" | "commands" | "work" = "full",
) {
  const lockedVm = await sql`
    WITH locked AS MATERIALIZED (
      SELECT id FROM assistant.vms WHERE id=${principal.vm_id} AND workspace_id=${principal.workspace_id} FOR UPDATE SKIP LOCKED
    )
    UPDATE assistant.vms AS vm SET last_seen_at=now() FROM locked WHERE vm.id=locked.id RETURNING vm.control_state
  `;
  if (!lockedVm[0]) return { assignment: null, commands: [], messages: [] };
  const vm = z.object({ control_state: z.string() }).parse(lockedVm[0]);
  const commands = z
    .array(Command)
    .parse(
      await sql`SELECT * FROM assistant.commands WHERE vm_id=${principal.vm_id} AND status='pending' ORDER BY created_at`,
    );
  if (view === "commands" && !runId) return { assignment: null, commands, messages: [] };
  const current =
    await sql`SELECT * FROM assistant.runs WHERE vm_id=${principal.vm_id} AND state NOT IN ('cancelled','succeeded','failed','unknown') FOR UPDATE`;
  if (current[0]) {
    const run = Run.parse(current[0]);
    if (run.state === "paused") return { assignment: null, commands, messages: [] };
    if (runId !== run.id) {
      if (
        runId &&
        (
          await sql`SELECT id FROM assistant.runs WHERE id=${runId} AND vm_id=${principal.vm_id} AND workspace_id=${principal.workspace_id} AND state IN ('unknown','cancelled','succeeded','failed')`
        )[0]
      )
        return { assignment: null, commands, messages: [] };
      await sql`UPDATE assistant.runs SET state='unknown',updated_at=now() WHERE id=${run.id}`;
      await sql`UPDATE assistant.tasks SET state='unknown',reason='Daemon restarted without active run journal',updated_at=now() WHERE id=${run.task_id}`;
      await publishAttentionMessage(sql, principal.workspace_id, { id: run.id, state: "unknown" });
      return { assignment: null, commands, messages: [] };
    }
    if (view === "commands") return { assignment: null, commands, messages: [] };
    const assignment = await (view === "work"
      ? workContext(sql, principal, run.id)
      : context(sql, principal, run.id));
    return { assignment: null, commands, messages: assignment.messages };
  }
  if (runId) return { assignment: null, commands, messages: [] };
  if ((await sql`SELECT vm_id FROM assistant.chatgpt_accounts WHERE vm_id=${principal.vm_id} AND request_status IN ('pending','running') AND lease_until>now()`).length)
    return { assignment: null, commands, messages: [] };
  if (vm.control_state !== "agent" || commands.length > 0)
    return { assignment: null, commands, messages: [] };
  const queued =
    await sql`SELECT * FROM assistant.tasks WHERE workspace_id=${principal.workspace_id} AND state='queued' AND NOT EXISTS(SELECT 1 FROM assistant.skill_executions e WHERE e.task_id=assistant.tasks.id AND e.vm_id<>${principal.vm_id}) ORDER BY created_at LIMIT 1 FOR UPDATE SKIP LOCKED`;
  if (!queued[0]) {
    const quarantined = z
      .array(Run)
      .parse(
        await sql`SELECT * FROM assistant.runs WHERE vm_id=${principal.vm_id} AND workspace_id=${principal.workspace_id} AND state='unknown' ORDER BY created_at,id FOR UPDATE`,
      );
    for (const run of quarantined)
      if (await validationRecoveryInput(sql, run.id))
        return { assignment: null, commands, messages: [], recovery_run_id: run.id };
    return { assignment: null, commands, messages: [] };
  }
  const task = Task.parse(queued[0]);
  const run = Run.parse(
    (
      await sql`INSERT INTO assistant.runs(workspace_id,task_id,vm_id) VALUES(${principal.workspace_id},${task.id},${principal.vm_id}) RETURNING *`
    )[0],
  );
  await sql`UPDATE assistant.tasks SET state='running',updated_at=now() WHERE id=${task.id}`;
  await pinRunModel(sql, { workspace: principal.workspace_id, vm: run.vm_id }, run.id);
  return {
    assignment: await (view === "work"
      ? workContext(sql, principal, run.id)
      : context(sql, principal, run.id)),
    commands,
    messages: [],
  };
}
