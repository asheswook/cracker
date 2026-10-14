import { z } from 'zod';
import { DomainError, Message } from '../../../packages/protocol';
import type { Principal } from '../auth';
import type { Query } from '../db';

// One data statement, no row locks. Its VM/run epoch predicates are evaluated in
// the same snapshot as the messages. The route uses a short read-only transaction
// so Hyperdrive cannot cache a positive authorization past a session rotation.
export async function readWorkMailbox(sql:Query,principal:Principal,run:string,after:number){
  const rows=await sql`
    WITH vm AS MATERIALIZED (
      SELECT id,daemon_session_id,daemon_reconciled FROM assistant.vms WHERE id=${principal.vm_id} AND workspace_id=${principal.workspace_id}
    ), owned AS MATERIALIZED (
      SELECT r.task_id FROM assistant.runs r JOIN vm v ON v.id=r.vm_id
      WHERE r.id=${run} AND r.workspace_id=${principal.workspace_id}
        AND v.daemon_session_id IS NOT DISTINCT FROM ${principal.daemon_session_id??null}::uuid
        AND r.daemon_session_id IS NOT DISTINCT FROM ${principal.daemon_session_id??null}::uuid
        AND (v.daemon_session_id IS NULL OR v.daemon_reconciled)
    )
    SELECT v.daemon_session_id IS NOT DISTINCT FROM ${principal.daemon_session_id??null}::uuid AS valid_session,
      (v.daemon_session_id IS NULL OR v.daemon_reconciled) AS reconciled,EXISTS(SELECT 1 FROM owned) AS owned,
      COALESCE((SELECT jsonb_agg(to_jsonb(m)||jsonb_build_object('attachments',COALESCE((
        SELECT jsonb_agg(to_jsonb(a) ORDER BY ma.position) FROM assistant.message_artifacts ma JOIN assistant.artifacts a ON a.id=ma.artifact_id WHERE ma.message_id=m.id
      ),'[]'::jsonb)) ORDER BY m.sequence) FROM assistant.messages m JOIN owned o ON o.task_id=m.task_id
        WHERE m.workspace_id=${principal.workspace_id} AND m.sequence>${after}),'[]'::jsonb) AS messages FROM vm v`;
  if(!rows[0])throw new DomainError('not_found','VM not found',404);
  const row=z.object({valid_session:z.boolean(),reconciled:z.boolean(),owned:z.boolean(),messages:z.array(Message)}).parse(rows[0]);
  if(!row.valid_session)throw new DomainError('stale_session','Daemon session was fenced',409);
  if(!row.reconciled)throw new DomainError('reconciliation_required','Reconcile the daemon journal before work',409);
  if(!row.owned)throw new DomainError('not_found','Owned run not found',404);
  return {messages:row.messages};
}
