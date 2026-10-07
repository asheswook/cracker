import { publishAttentionMessage } from "../../../packages/notifications/attention.ts";
import { z } from "zod";
import type { Database } from "../db";
export async function quarantineStaleRuns(sql: Database, staleAfterSeconds = 120): Promise<number> {
  const seconds = z.number().int().min(30).parse(staleAfterSeconds);
  return sql.begin(async (tx) => {
    const rows = z
      .array(z.object({ id: z.uuid(), task_id: z.uuid(), workspace_id: z.uuid() }))
      .parse(
        await tx`SELECT r.id,r.task_id,r.workspace_id FROM assistant.runs r JOIN assistant.vms v ON v.id=r.vm_id WHERE r.state IN ('running','waiting','pausing','cancelling') AND COALESCE(v.last_seen_at,r.created_at)<now()-(${seconds} * interval '1 second') FOR UPDATE OF r SKIP LOCKED`,
      );
    for (const run of rows) {
      await tx`UPDATE assistant.runs SET state='unknown',updated_at=now() WHERE id=${run.id}`;
      await tx`UPDATE assistant.tasks SET state='unknown',reason='VM heartbeat expired; reconcile journal before resuming',updated_at=now() WHERE id=${run.task_id}`;
      await publishAttentionMessage(tx,run.workspace_id,{id:run.id,state:"unknown"});
    }
    return rows.length;
  });
}
