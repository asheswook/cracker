import type { Query } from "../db";
import { z } from "zod";

export async function validationRecoveryInput(sql: Query, run: string, cursor = 0): Promise<boolean> {
  const rows = await sql`SELECT m.id FROM assistant.runs r
    JOIN assistant.tasks t ON t.id=r.task_id AND t.workspace_id=r.workspace_id
    JOIN assistant.messages m ON m.task_id=t.id AND m.workspace_id=t.workspace_id
    WHERE r.id=${run} AND r.state='unknown' AND t.state='unknown'
      AND t.reason IN (
        'Invalid provider response: invalid_tool_arguments; no calls from that response were executed',
        'Control disconnected during execution; reconcile interrupted effects before resuming',
        'Runtime/provider/tool failure; inspect protected local journal before resuming'
      )
      AND m.role='user' AND m.sequence>${cursor} AND m.created_at>r.updated_at
      AND NOT EXISTS(SELECT 1 FROM assistant.input_receipts i WHERE i.run_id=r.id AND i.message_id=m.id)
    LIMIT 1`;
  return z.array(z.object({id:z.uuid()})).parse(rows).length > 0;
}
