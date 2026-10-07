import type { Query } from "../db";

export async function returnControlForMessage(sql: Query, workspace: string, task: string) {
  await sql`
    WITH target AS (
      SELECT v.id FROM assistant.vms v
      WHERE v.workspace_id=${workspace} AND v.control_state='user'
        AND NOT EXISTS (SELECT 1 FROM assistant.commands c WHERE c.vm_id=v.id AND c.status='pending')
        AND (
          EXISTS (SELECT 1 FROM assistant.runs r WHERE r.vm_id=v.id AND r.task_id=${task}
            AND r.state NOT IN ('cancelled','succeeded','failed','unknown'))
          OR (
            (SELECT count(*) FROM assistant.vms owned WHERE owned.workspace_id=${workspace})=1
            AND NOT EXISTS (SELECT 1 FROM assistant.runs r WHERE r.vm_id=v.id
              AND r.state NOT IN ('cancelled','succeeded','failed','unknown'))
          )
        )
    ), enqueued AS (
      INSERT INTO assistant.commands(workspace_id,vm_id,kind)
      SELECT ${workspace},id,'return_control' FROM target RETURNING vm_id
    )
    UPDATE assistant.vms v SET control_state='switching' FROM enqueued WHERE v.id=enqueued.vm_id`;
}
