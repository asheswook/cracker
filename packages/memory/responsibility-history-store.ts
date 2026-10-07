import type { z } from "zod";
import type { Database } from "../../services/control/db";
import { DomainError } from "../protocol";
import { ResponsibilityHistory, type ResponsibilityHistoryQuery } from "./responsibility-history-schema";

export async function responsibilityHistory(
  sql: Database, workspace: string, responsibility: string,
  query: z.infer<typeof ResponsibilityHistoryQuery>,
): Promise<z.infer<typeof ResponsibilityHistory>> {
  const owned = await sql`SELECT id FROM assistant.responsibilities WHERE workspace_id=${workspace} AND id=${responsibility}`;
  if (!owned[0]) throw new DomainError("not_found", "Responsibility not found", 404);
  const cursor = query.cursor ?? null;
  if (cursor) {
    const found = await sql`SELECT id FROM assistant.responsibility_actions WHERE workspace_id=${workspace} AND responsibility_id=${responsibility} AND id=${cursor}`;
    if (!found[0]) throw new DomainError("invalid_cursor", "History cursor not found", 400);
  }
  const page = ResponsibilityHistory.parse({
    runs: await sql`
      SELECT a.id,a.state,a.created_at,a.scheduled_for,
        CASE WHEN t.id IS NULL THEN NULL ELSE to_jsonb(t) END AS task
      FROM assistant.responsibility_actions a
      LEFT JOIN assistant.tasks t ON t.workspace_id=a.workspace_id AND t.id=a.task_id
      WHERE a.workspace_id=${workspace} AND a.responsibility_id=${responsibility}
        AND (${cursor}::uuid IS NULL OR (a.created_at,a.id) < (
          SELECT c.created_at,c.id FROM assistant.responsibility_actions c
          WHERE c.workspace_id=${workspace} AND c.responsibility_id=${responsibility} AND c.id=${cursor}
        ))
      ORDER BY a.created_at DESC,a.id DESC LIMIT ${query.limit + 1}
    `,
    next_cursor: null,
  });
  const runs = page.runs.slice(0, query.limit);
  return { runs, next_cursor: page.runs.length > query.limit ? runs.at(-1)?.id ?? null : null };
}
