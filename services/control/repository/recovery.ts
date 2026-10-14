import { publishAttentionMessage } from "../../../packages/notifications/attention.ts";
import { z } from "zod";
import type { Database } from "../db";
export async function quarantineStaleRuns(sql: Database, staleAfterSeconds = 120): Promise<number> {
  const seconds = z.number().int().min(30).parse(staleAfterSeconds);
  return sql.begin(async (tx) => {
    const workspaces=z.array(z.object({id:z.uuid()})).parse(await tx`
      SELECT w.id FROM assistant.workspaces w WHERE EXISTS(SELECT 1 FROM assistant.runs r JOIN assistant.vms v ON v.id=r.vm_id
        WHERE r.workspace_id=w.id AND r.state IN ('running','waiting','pausing','cancelling')
        AND COALESCE(v.last_seen_at,r.created_at)<now()-(${seconds} * interval '1 second'))
      ORDER BY w.id FOR KEY SHARE OF w SKIP LOCKED`);
    if(!workspaces.length)return 0;
    const vms=z.array(z.object({id:z.uuid()})).parse(await tx`
      SELECT v.id FROM assistant.vms v WHERE v.workspace_id=ANY(${tx.array(workspaces.map(workspace=>workspace.id))}::uuid[]) AND EXISTS(
        SELECT 1 FROM assistant.runs r WHERE r.vm_id=v.id AND r.state IN ('running','waiting','pausing','cancelling')
        AND COALESCE(v.last_seen_at,r.created_at)<now()-(${seconds} * interval '1 second'))
      ORDER BY v.id FOR UPDATE OF v SKIP LOCKED`);
    if(!vms.length)return 0;
    const rows = z
      .array(z.object({ id: z.uuid(), task_id: z.uuid(), workspace_id: z.uuid() }))
      .parse(
        await tx`SELECT r.id,r.task_id,r.workspace_id FROM assistant.runs r JOIN assistant.vms v ON v.id=r.vm_id
          WHERE v.id=ANY(${tx.array(vms.map(vm=>vm.id))}::uuid[]) AND r.state IN ('running','waiting','pausing','cancelling')
          AND COALESCE(v.last_seen_at,r.created_at)<now()-(${seconds} * interval '1 second') ORDER BY r.id FOR UPDATE OF r SKIP LOCKED`,
      );
    for (const run of rows) {
      await tx`UPDATE assistant.runs SET state='unknown',updated_at=now() WHERE id=${run.id}`;
      await tx`UPDATE assistant.tasks SET state='unknown',reason='VM heartbeat expired; reconcile journal before resuming',updated_at=now() WHERE id=${run.task_id}`;
      await publishAttentionMessage(tx,run.workspace_id,{id:run.id,state:"unknown"});
    }
    return rows.length;
  });
}
