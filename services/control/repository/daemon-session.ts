import { z } from 'zod';
import { DomainError } from '../../../packages/protocol';
import { SessionRegistration } from '../../../packages/protocol/parallel-runs';
import { publishAttentionMessage } from '../../../packages/notifications/attention';
import type { Principal } from '../auth';
import type { Query } from '../db';
import { lockWorkspace } from './lock-order';
export type VmLock='update'|'no-key-update'|'share'|'key-share';

export async function fenceSession(sql: Query, principal: Principal, session?: string,lock:boolean|VmLock=true) {
  if(lock!==false)await lockWorkspace(sql,principal.workspace_id);
  const rows=lock==='key-share'?await sql`SELECT daemon_session_id,daemon_reconciled FROM assistant.vms WHERE id=${principal.vm_id} AND workspace_id=${principal.workspace_id} FOR KEY SHARE`
    :lock==='no-key-update'?await sql`SELECT daemon_session_id,daemon_reconciled FROM assistant.vms WHERE id=${principal.vm_id} AND workspace_id=${principal.workspace_id} FOR NO KEY UPDATE`
    :lock==='share'?await sql`SELECT daemon_session_id,daemon_reconciled FROM assistant.vms WHERE id=${principal.vm_id} AND workspace_id=${principal.workspace_id} FOR SHARE`
    :lock?await sql`SELECT daemon_session_id,daemon_reconciled FROM assistant.vms WHERE id=${principal.vm_id} AND workspace_id=${principal.workspace_id} FOR UPDATE`
      :await sql`SELECT daemon_session_id,daemon_reconciled FROM assistant.vms WHERE id=${principal.vm_id} AND workspace_id=${principal.workspace_id}`;
  const vm = z.object({daemon_session_id:z.uuid().nullable(),daemon_reconciled:z.boolean()}).parse(rows[0]);
  // Old daemons remain serial only until the VM first registers the new protocol.
  if (!vm.daemon_session_id && !session) return;
  if (!session || vm.daemon_session_id !== session) throw new DomainError('stale_session','Daemon session was fenced',409);
  if (!vm.daemon_reconciled) throw new DomainError('reconciliation_required','Reconcile the daemon journal before work',409);
}

// Must run inside the mutation transaction; SHARE prevents registration/adoption
// until that transaction commits. Legacy VMs/runs must both have null sessions.
export async function fenceRun(sql:Query,principal:Principal,run?:string,lock:boolean|VmLock=true,runLock:'share'|'update'='share'){
  if(principal.role!=='vm')return;
  await fenceSession(sql,principal,principal.daemon_session_id,lock===true?'share':lock);
  if(!run)return;
  const rows=lock&&runLock==='update'?await sql`SELECT id FROM assistant.runs WHERE id=${run} AND workspace_id=${principal.workspace_id} AND vm_id=${principal.vm_id}
    AND daemon_session_id IS NOT DISTINCT FROM ${principal.daemon_session_id??null}::uuid FOR UPDATE`
    :lock?await sql`SELECT id FROM assistant.runs WHERE id=${run} AND workspace_id=${principal.workspace_id} AND vm_id=${principal.vm_id}
    AND daemon_session_id IS NOT DISTINCT FROM ${principal.daemon_session_id??null}::uuid FOR SHARE`
    :await sql`SELECT id FROM assistant.runs WHERE id=${run} AND workspace_id=${principal.workspace_id} AND vm_id=${principal.vm_id}
      AND daemon_session_id IS NOT DISTINCT FROM ${principal.daemon_session_id??null}::uuid`;
  if(!rows.length)throw new DomainError('not_found','Owned run not found',404);
}

export async function registerSession(sql: Query, principal: Principal, request: z.infer<typeof SessionRegistration>) {
  if (new Set(request.runs.map(run=>run.run_id)).size !== request.runs.length) throw new DomainError('invalid_request','Duplicate journal run',400);
  await lockWorkspace(sql,principal.workspace_id);
  const vm = z.object({daemon_session_id:z.uuid().nullable(),daemon_epoch:z.coerce.number()}).parse((await sql`
    SELECT daemon_session_id,daemon_epoch FROM assistant.vms WHERE id=${principal.vm_id} AND workspace_id=${principal.workspace_id} FOR UPDATE`)[0]);
  const prior = await sql`SELECT id FROM assistant.daemon_sessions WHERE id=${request.session_id}`;
  if (prior.length) {
    if(vm.daemon_session_id!==request.session_id)throw new DomainError('stale_session','A fenced session cannot register again',409);
    const adopted=z.array(z.object({id:z.uuid()})).parse(await sql`SELECT id FROM assistant.runs WHERE vm_id=${principal.vm_id} AND daemon_session_id=${request.session_id}`);
    return {reconciled:true as const,epoch:vm.daemon_epoch,adopted:adopted.map(run=>run.id),quarantined:[]};
  }
  const epoch=vm.daemon_epoch+1;
  await sql`INSERT INTO assistant.daemon_sessions(id,vm_id,epoch) VALUES(${request.session_id},${principal.vm_id},${epoch})`;
  await sql`UPDATE assistant.vms SET daemon_session_id=${request.session_id},daemon_epoch=${epoch},daemon_reconciled=false WHERE id=${principal.vm_id}`;
  const reports=new Map(request.runs.map(run=>[run.run_id,run]));
  const rows=z.array(z.object({id:z.uuid(),task_id:z.uuid(),accepted_at:z.string().nullable(),offered_at:z.string().nullable()})).parse(await sql`
    SELECT id,task_id,accepted_at,offered_at FROM assistant.runs WHERE vm_id=${principal.vm_id}
    AND state NOT IN ('cancelled','succeeded','failed','unknown') ORDER BY created_at,id FOR UPDATE`);
  const adopted:string[]=[],quarantined:string[]=[];
  for(const run of rows){
    const report=reports.get(run.id);
    if(report&&(report.recoverable||report.phase==='terminal-pending')){
      await sql`UPDATE assistant.runs SET daemon_session_id=${request.session_id},accepted_at=COALESCE(accepted_at,now()) WHERE id=${run.id}`;
      adopted.push(run.id);
    }else if(!report&&run.offered_at&&!run.accepted_at){
      // An offer is reserved, not executed. A lost response is safe to offer again.
      await sql`UPDATE assistant.runs SET daemon_session_id=${request.session_id} WHERE id=${run.id}`;
    }else{
      await sql`UPDATE assistant.runs SET state='unknown',daemon_session_id=${request.session_id},updated_at=now() WHERE id=${run.id}`;
      await sql`UPDATE assistant.tasks SET state='unknown',reason='Startup journal cannot prove effect safety; reconciliation required',updated_at=now() WHERE id=${run.task_id}`;
      await publishAttentionMessage(sql,principal.workspace_id,{id:run.id,state:'unknown'});
      quarantined.push(run.id);
    }
  }
  // Retain ownership of terminal receipts and validation-recovery checkpoints too.
  for(const report of request.runs)if(!adopted.includes(report.run_id)&&!quarantined.includes(report.run_id)){
    const updated=await sql`UPDATE assistant.runs SET daemon_session_id=${request.session_id} WHERE id=${report.run_id} AND vm_id=${principal.vm_id} AND workspace_id=${principal.workspace_id} RETURNING id`;
    if(updated.length)adopted.push(report.run_id);
  }
  await sql`UPDATE assistant.vms SET daemon_reconciled=true WHERE id=${principal.vm_id}`;
  return {reconciled:true as const,epoch,adopted,quarantined};
}

export async function acceptOffer(sql: Query, principal: Principal, session: string | undefined, runId: string) {
  await fenceSession(sql,principal,session);
  const offered=await sql`SELECT id FROM assistant.runs WHERE id=${runId} AND vm_id=${principal.vm_id} AND workspace_id=${principal.workspace_id}
    AND daemon_session_id=${session??null} AND offered_at IS NOT NULL AND state NOT IN ('cancelled','succeeded','failed','unknown') FOR UPDATE`;
  if(!offered.length)throw new DomainError('stale_run','Offer no longer belongs to this session',409);
  const barriers=await sql`SELECT 1 FROM assistant.commands c WHERE c.vm_id=${principal.vm_id} AND c.status='pending'
    AND (c.kind<>'stop' OR c.task_id IS NULL OR c.task_id=(SELECT task_id FROM assistant.runs WHERE id=${runId} AND vm_id=${principal.vm_id}))
    UNION ALL SELECT 1 FROM assistant.chatgpt_accounts WHERE vm_id=${principal.vm_id} AND request_status IN ('pending','running') AND lease_until>now() LIMIT 1`;
  if(barriers.length)throw new DomainError('command_pending','Apply task stop or VM control barriers before acceptance',409);
  const vm=z.object({control_state:z.string()}).parse((await sql`SELECT control_state FROM assistant.vms WHERE id=${principal.vm_id}`)[0]);
  if(!['agent','user'].includes(vm.control_state))throw new DomainError('command_pending','VM control has not reconciled',409);
  const rows=await sql`UPDATE assistant.runs SET accepted_at=COALESCE(accepted_at,now()),updated_at=now()
    WHERE id=${runId} AND vm_id=${principal.vm_id} AND workspace_id=${principal.workspace_id}
    AND daemon_session_id=${session??null} AND offered_at IS NOT NULL
    AND state NOT IN ('cancelled','succeeded','failed','unknown') RETURNING id`;
  if(!rows.length)throw new DomainError('stale_run','Offer no longer belongs to this session',409);
  return {accepted:true as const};
}
