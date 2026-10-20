import { z } from "zod";
import { preserveAttentionReason } from "../../../packages/notifications/attention";
import { DomainError, RecoveryContext, type RecoverySummary } from "../../../packages/protocol";
import type { Principal } from "../auth";
import type { Query } from "../db";
import { recordEvent } from "./common";
import { loadRun } from "./runs";
import { workContext } from "./task-context";
import { validationRecoveryInput } from "./validation-recovery";
import { admission } from './run-admission';
import { lockWorkspace } from './lock-order';
import { fenceSession } from './daemon-session';

export async function resumeRun(
  sql: Query,
  principal: Principal,
  runId: string,
  checkpointCursor?: number,
  desktopControlScoped = false,
  recovery?: z.infer<typeof RecoverySummary>,
) {
  await lockWorkspace(sql,principal.workspace_id);
  const vm = z
    .object({ control_state: z.string() })
    .parse(
      (
        await sql`SELECT control_state FROM assistant.vms WHERE id=${principal.vm_id} AND workspace_id=${principal.workspace_id} FOR UPDATE`
      )[0],
    );
  await fenceSession(sql,principal,principal.daemon_session_id,false);
  if((checkpointCursor!==undefined||recovery!==undefined)&&await validationRecoveryInput(sql,runId,checkpointCursor??0)){
    await sql`UPDATE assistant.runs SET daemon_session_id=${principal.daemon_session_id??null} WHERE id=${runId} AND workspace_id=${principal.workspace_id} AND vm_id=${principal.vm_id} AND state='unknown'`;
  }
  const run = await loadRun(sql, principal, runId);
  if ((await sql`SELECT vm_id FROM assistant.chatgpt_accounts WHERE vm_id=${principal.vm_id} AND request_status IN ('pending','running') AND lease_until>now()`).length)
    throw new DomainError("command_pending", "Account connection is being changed", 409);
  const existing=recovery?z.object({id:z.uuid(),state:z.string()}).optional().parse((await sql`SELECT id,state FROM assistant.runs WHERE workspace_id=${principal.workspace_id} AND recovery->>'source_run_id'=${runId}`)[0]):undefined;
  if(recovery){
    if(existing){
      if(existing.state!=='running')throw new DomainError('resume_unavailable','Failure explanation already finished',409);
    }
    if(run.state!=='unknown')throw new DomainError('resume_unavailable','Only interrupted runs need a fresh explanation',409);
  }
  const validationRecovery =
    run.state === "unknown" &&
    (checkpointCursor !== undefined || recovery!==undefined) &&
    (existing!==undefined || await validationRecoveryInput(sql, run.id, checkpointCursor??0));
  if (!["running", "waiting", "paused"].includes(run.state) && !validationRecovery)
    throw new DomainError("resume_unavailable", "Run cannot resume from this state", 409);
  if (vm.control_state !== "agent" && !(desktopControlScoped && vm.control_state === "user"))
    throw new DomainError(
      "control_unavailable",
      "Computer control has not returned to the assistant",
      409,
    );
  const slots=await admission(sql,principal,existing?.id??runId);
  const conversation = z.object({conversation_id:z.uuid(),lane:z.enum(['foreground','background'])}).parse((await sql`SELECT conversation_id,lane FROM assistant.tasks WHERE id=${run.task_id}`)[0]);
  if(!slots[conversation.lane])throw new DomainError('run_busy','Run lane is occupied',409);
  await sql`SELECT id FROM assistant.conversations WHERE id=${conversation.conversation_id} AND workspace_id=${principal.workspace_id} FOR UPDATE`;
  const occupied = await sql`SELECT id FROM assistant.tasks WHERE conversation_id=${conversation.conversation_id} AND lane='foreground' AND ${conversation.lane==='foreground'} AND id<>${run.task_id} AND state NOT IN ('cancelled','succeeded','failed','unknown') LIMIT 1`;
  if(occupied.length)throw new DomainError('run_busy','Another task occupies this conversation',409);
  const commands =
    await sql`SELECT id FROM assistant.commands WHERE vm_id=${principal.vm_id} AND status='pending' AND (kind<>'stop' OR task_id IS NULL OR task_id=${run.task_id}) LIMIT 1`;
  if (commands.length)
    throw new DomainError("command_pending", "Apply pending control commands before resuming", 409);
  const task = z
    .object({ state: z.string(),reason:z.string().nullable() })
    .parse(
      (
        await sql`SELECT state,reason FROM assistant.tasks WHERE id=${run.task_id} AND workspace_id=${principal.workspace_id} FOR UPDATE`
      )[0],
    );
  if (
    !["running", "waiting", "paused"].includes(task.state) &&
    !(validationRecovery && task.state === "unknown")
  )
    throw new DomainError("resume_unavailable", "Task cannot resume from this state", 409);
  if(existing)return workContext(sql,principal,existing.id);
  if (validationRecovery) await preserveAttentionReason(sql, principal.workspace_id, runId);
  if(recovery){
    const detail=RecoveryContext.parse({...recovery,mode:'explain_only',source_run_id:run.id,reason:task.reason??'Execution history could not be recovered'});
    const replacement=z.object({id:z.uuid()}).parse((await sql`INSERT INTO assistant.runs(workspace_id,task_id,vm_id,lane,daemon_session_id,accepted_at,recovery) VALUES(${principal.workspace_id},${run.task_id},${principal.vm_id},${conversation.lane},${principal.daemon_session_id??null},now(),${JSON.stringify(detail)}::text::jsonb) RETURNING id`)[0]);
    await sql`INSERT INTO assistant.run_models(run_id,revision_id,selection,secret_cipher) SELECT ${replacement.id},revision_id,selection,secret_cipher FROM assistant.run_models WHERE run_id=${run.id}`;
    await sql`UPDATE assistant.tasks SET state='running',reason=NULL,updated_at=now() WHERE id=${run.task_id}`;
    await recordEvent(sql,{workspace:principal.workspace_id,kind:'task.resumed',payload:JSON.stringify({task_id:run.task_id,run_id:replacement.id,source_run_id:run.id,mode:'explain_only'})});
    return workContext(sql,principal,replacement.id);
  }
  await sql`UPDATE assistant.runs SET state='running',updated_at=now() WHERE id=${runId}`;
  await sql`UPDATE assistant.tasks SET state='running',reason=NULL,updated_at=now() WHERE id=${run.task_id}`;
  await recordEvent(sql, {
    workspace: principal.workspace_id,
    kind: "task.resumed",
    payload: JSON.stringify({ task_id: run.task_id, run_id: runId }),
  });
  return workContext(sql, principal, runId);
}
