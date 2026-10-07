import { z } from "zod";
import type { Database } from "../../services/control/db";
import { Task } from "../protocol";
import { ResponsibilityRow } from "./responsibility-store";

export const ResponsibilityView = ResponsibilityRow.extend({
  last_error: z.string().nullable(),
  last_evaluated_at: z.string().nullable(),
  last_action: z.object({
    state: z.enum(["pending", "dispatched", "cancelled"]),
    created_at: z.string(),
    scheduled_for: z.string().nullable(),
    task: Task.nullable(),
  }).nullable(),
});

export async function listResponsibilities(sql: Database, workspace: string) {
  return z.array(ResponsibilityView).parse(await sql`
    SELECT r.*, CASE WHEN a.id IS NULL THEN NULL ELSE jsonb_build_object(
      'state',a.state,'created_at',a.created_at,'scheduled_for',a.scheduled_for,
      'task',CASE WHEN t.id IS NULL THEN NULL ELSE to_jsonb(t) END) END AS last_action
    FROM assistant.responsibilities r
    LEFT JOIN LATERAL (
      SELECT * FROM assistant.responsibility_actions
      WHERE workspace_id=r.workspace_id AND responsibility_id=r.id
      ORDER BY created_at DESC,id DESC LIMIT 1
    ) a ON true
    LEFT JOIN assistant.tasks t ON t.workspace_id=r.workspace_id AND t.id=a.task_id
    WHERE r.workspace_id=${workspace}
    ORDER BY (r.state='active') DESC,r.created_at DESC LIMIT 100
  `);
}
