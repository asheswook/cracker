import type { Query } from "../db";
import { z } from "zod";

export async function validationRecoveryInput(sql: Query, run: string, cursor = 0): Promise<boolean> {
  const rows = await sql`SELECT m.id FROM assistant.runs r
    JOIN assistant.tasks t ON t.id=r.task_id AND t.workspace_id=r.workspace_id
    JOIN assistant.messages m ON m.task_id=t.id AND m.workspace_id=t.workspace_id
    WHERE r.id=${run} AND r.state='unknown' AND t.state='unknown'
      AND NOT EXISTS(SELECT 1 FROM assistant.runs replacement WHERE replacement.workspace_id=r.workspace_id AND replacement.recovery->>'source_run_id'=r.id::text)
      AND m.role='user' AND m.sequence>${cursor}
      AND NOT EXISTS(SELECT 1 FROM assistant.input_receipts i WHERE i.run_id=r.id AND i.message_id=m.id)
    LIMIT 1`;
  return z.array(z.object({id:z.uuid()})).parse(rows).length > 0;
}
