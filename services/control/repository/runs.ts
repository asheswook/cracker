import { sourceRunPolicy } from "../../../packages/attention/sources";
import { z } from "zod";
import { taskSkill } from "../../../packages/extensions/versions.ts";
import { retrieveMemory } from "../../../packages/memory/persist";
import { pinRunModel, runModelBinding } from "../../../packages/models/repository.ts";
import { fenceSession, type VmLock } from './daemon-session';
import { admission } from './run-admission';
import { lockWorkspace } from './lock-order';
import { Assignment, Command, DomainError, Persona, RecoveryContext, Task } from "../../../packages/protocol";
import type { Principal } from "../auth";
import type { Query } from "../db";
import { messages } from "./common";
import { workContext, workMailbox } from "./task-context";
import { validationRecoveryInput } from "./validation-recovery";
export const Run = z.object({
  id: z.uuid(),
  task_id: z.uuid(),
  vm_id: z.uuid(),
  state: z.string(),
  recovery: RecoveryContext.nullish(),
});
export async function loadRun(sql: Query, principal: Principal, id: string,lock:VmLock|false='update') {
  await fenceSession(sql,principal,principal.daemon_session_id,lock);
  const rows =
    lock?await sql`SELECT * FROM assistant.runs WHERE id=${id} AND workspace_id=${principal.workspace_id} AND vm_id=${principal.vm_id}
      AND daemon_session_id IS NOT DISTINCT FROM ${principal.daemon_session_id??null}::uuid FOR UPDATE`
      :await sql`SELECT * FROM assistant.runs WHERE id=${id} AND workspace_id=${principal.workspace_id} AND vm_id=${principal.vm_id}
        AND daemon_session_id IS NOT DISTINCT FROM ${principal.daemon_session_id??null}::uuid`;
  if (!rows[0]) throw new DomainError("not_found", "Run not found", 404);
  return Run.parse(rows[0]);
}
export async function context(sql: Query, principal: Principal, id: string, after = 0) {
  const run = await loadRun(sql, principal, id,false);
  const rows = await sql`SELECT * FROM assistant.tasks WHERE id=${run.task_id}`;
  const task = Task.parse(rows[0]);
  if(task.lane==='background'){
    const assignment=await workContext(sql,principal,id);
    return {...assignment,messages:assignment.messages.filter(message=>message.sequence>after)};
  }
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
    ...await (async () => { const policy = await sourceRunPolicy(sql, principal.workspace_id, task.id); return policy ? { run_policy: policy } : {}; })(),
    task,
    lane: task.lane ?? 'foreground',
    run_id: run.id,
    ...(run.recovery ? { recovery: run.recovery } : {}),
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
  await loadRun(sql,principal,cursor.runId,false);
  const rows =
    await sql`SELECT t.conversation_id,t.lane FROM assistant.runs r JOIN assistant.tasks t ON t.id=r.task_id AND t.workspace_id=r.workspace_id WHERE r.id=${cursor.runId} AND r.workspace_id=${principal.workspace_id} AND r.vm_id=${principal.vm_id}`;
  if (!rows[0]) throw new DomainError("not_found", "Run not found", 404);
  const task = z.object({ conversation_id: z.uuid(), lane: z.enum(['foreground','background']) }).parse(rows[0]);
  if(task.lane==='background')return workMailbox(sql,principal,cursor.runId,cursor.after);
  return {
    messages: await messages(sql, principal.workspace_id, task.conversation_id, cursor.after),
  };
}
export async function poll(
  sql: Query,
  principal: Principal,
  runId: string | undefined,
  view: "full" | "commands" | "work" = "full",
  desktopControlScoped = false,
  session?: string,
) {
  session??=principal.daemon_session_id;
  if(!await lockWorkspace(sql,principal.workspace_id,'share',true))return {assignment:null,commands:[],messages:[]};
  const lockedVm = await sql`
    WITH locked AS MATERIALIZED (
      SELECT id FROM assistant.vms WHERE id=${principal.vm_id} AND workspace_id=${principal.workspace_id} FOR NO KEY UPDATE SKIP LOCKED
    )
    UPDATE assistant.vms AS vm SET last_seen_at=now() FROM locked WHERE vm.id=locked.id RETURNING vm.control_state
  `;
  if (!lockedVm[0]) return { assignment: null, commands: [], messages: [] };
  await fenceSession(sql,principal,session,'key-share');
  const vm = z.object({ control_state: z.string() }).parse(lockedVm[0]);
  const commands = z
    .array(Command)
    .parse(
      await sql`SELECT * FROM assistant.commands WHERE vm_id=${principal.vm_id} AND status='pending' ORDER BY created_at,id`,
    );
  if (view === "commands" && !runId) return { assignment: null, commands, messages: [] };
  const current =
    await sql`SELECT * FROM assistant.runs WHERE vm_id=${principal.vm_id} AND state NOT IN ('cancelled','succeeded','failed','unknown')`;
  const matching=current.find(row=>row['id']===runId);
  if (matching) {
    const run = Run.parse(matching);
    if (view === "commands" || run.state==='paused') return { assignment: null, commands, messages: [] };
    const assignment = await (view === "work"
      ? workContext(sql, principal, run.id)
      : context(sql, principal, run.id));
    return { assignment: null, commands, messages: assignment.messages };
  }
  if (view==='commands'||runId) return { assignment: null, commands, messages: [] };
  if ((await sql`SELECT vm_id FROM assistant.chatgpt_accounts WHERE vm_id=${principal.vm_id} AND request_status IN ('pending','running') AND lease_until>now()`).length)
    return { assignment: null, commands, messages: [] };
  if ((vm.control_state !== "agent" && !(desktopControlScoped && vm.control_state === "user")) || commands.some(command=>command.kind!=='stop'||!command.task_id))
    return { assignment: null, commands, messages: [] };
  if(session){
    const offer=await sql`SELECT r.id FROM assistant.runs r WHERE vm_id=${principal.vm_id} AND daemon_session_id=${session}
      AND offered_at IS NOT NULL AND accepted_at IS NULL AND state NOT IN ('cancelled','succeeded','failed','unknown')
      AND NOT EXISTS(SELECT 1 FROM assistant.commands c WHERE c.vm_id=r.vm_id AND c.task_id=r.task_id AND c.kind='stop' AND c.status='pending') ORDER BY created_at,id LIMIT 1`;
    if(offer[0]){
      const id=z.object({id:z.uuid()}).parse(offer[0]).id;
      return {assignment:{...await (view==='work'?workContext(sql,principal,id):context(sql,principal,id)),offered:true},commands,messages:[]};
    }
  }
  const slots=await admission(sql,principal);
  const queued =
    await sql`SELECT * FROM assistant.tasks t WHERE workspace_id=${principal.workspace_id} AND state='queued'
      AND ((lane='foreground' AND ${slots.foreground}) OR (lane='background' AND ${slots.background}))
      AND NOT EXISTS(SELECT 1 FROM assistant.commands c WHERE c.vm_id=${principal.vm_id} AND c.status='pending' AND c.kind='stop' AND c.task_id=t.id)
      AND NOT EXISTS(SELECT 1 FROM assistant.skill_executions e WHERE e.task_id=t.id AND e.vm_id<>${principal.vm_id}) ORDER BY (lane='background'),created_at,id LIMIT 1 FOR UPDATE SKIP LOCKED`;
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
      await sql`INSERT INTO assistant.runs(workspace_id,task_id,vm_id,daemon_session_id,offered_at) VALUES(${principal.workspace_id},${task.id},${principal.vm_id},${session??null},${session?new Date().toISOString():null}) RETURNING *`
    )[0],
  );
  await sql`UPDATE assistant.tasks SET state='running',updated_at=now() WHERE id=${task.id}`;
  await pinRunModel(sql, { workspace: principal.workspace_id, vm: run.vm_id }, run.id);
  return {
    assignment: {...await (view === "work"
      ? workContext(sql, principal, run.id)
      : context(sql, principal, run.id)),...(session?{offered:true}:{})},
    commands,
    messages: [],
  };
}
