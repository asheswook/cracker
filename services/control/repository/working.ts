import { z } from "zod";
import type { Query } from "../db";

const WorkingState = z.object({
  task_id: z.uuid(),
  run_id: z.uuid(),
  input_message_id: z.uuid(),
  expires_at: z.iso.datetime(),
  activity: z.enum(["computer"]).nullable(),
});

export async function workingState(sql: Query, workspace: string, conversation: string) {
  const rows = await sql`
    SELECT t.id AS task_id,r.id AS run_id,m.id AS input_message_id,
      LEAST(now()+interval '5 seconds',v.last_seen_at+interval '60 seconds') AS expires_at,
      CASE WHEN r.activity_at>now()-interval '20 seconds' THEN r.activity END AS activity
    FROM assistant.tasks t
    JOIN assistant.runs r ON r.task_id=t.id AND r.workspace_id=t.workspace_id
    JOIN assistant.vms v ON v.id=r.vm_id AND v.workspace_id=r.workspace_id
    JOIN LATERAL (
      SELECT id FROM assistant.messages
      WHERE workspace_id=t.workspace_id AND conversation_id=t.conversation_id AND role='user'
      ORDER BY sequence DESC LIMIT 1
    ) m ON true
    JOIN assistant.input_receipts i ON i.run_id=r.id AND i.message_id=m.id AND i.workspace_id=t.workspace_id
    WHERE t.workspace_id=${workspace} AND t.conversation_id=${conversation}
      AND t.lane='foreground' AND r.lane='foreground' AND t.state='running' AND r.state='running' AND i.applied_at IS NOT NULL
      AND v.control_state IN ('agent','user') AND v.last_seen_at>now()-interval '60 seconds'
      AND NOT EXISTS (
        SELECT 1 FROM assistant.commands cmd
        WHERE cmd.workspace_id=t.workspace_id AND cmd.vm_id=v.id AND cmd.status='pending'
          AND (cmd.kind IN ('takeover','return_control') OR
            (cmd.kind='stop' AND (cmd.run_id=r.id OR cmd.task_id=t.id)))
      )
    LIMIT 1`;
  return rows[0] ? WorkingState.parse(rows[0]) : null;
}
export async function backgroundState(sql: Query, workspace: string, conversation: string) {
  const items=z.array(z.object({task_id:z.uuid(),objective:z.string().max(140),state:z.enum(['queued','running','waiting','paused']),started_at:z.string().nullable()})).parse(await sql`
    SELECT t.id AS task_id,left(t.objective,140) AS objective,t.state,
      (SELECT min(r.created_at) FROM assistant.runs r WHERE r.task_id=t.id) AS started_at
    FROM assistant.tasks t WHERE t.workspace_id=${workspace} AND t.conversation_id=${conversation}
      AND t.lane='background' AND t.state IN ('queued','running','waiting','paused') ORDER BY t.created_at,t.id`);
  return {count:items.length,items};
}
