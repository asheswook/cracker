import { z } from "zod";
import { hashToken, type Principal } from "../../services/control/auth.ts";
import type { Query } from "../../services/control/db.ts";
import { Schedule } from "../../services/control/repository/schedule-enrollment.ts";
import { ResponsibilityRow } from "../memory/responsibility-store.ts";
import { DomainError } from "../protocol/index.ts";
import {
  FutureWork,
  FutureWorkListInput,
  ResponsibilityConfiguration,
  ScheduleConfiguration,
} from "./schema.ts";

export async function ownedRun(sql: Query, principal: Principal, runId: string) {
  const rows =
    await sql`SELECT r.task_id FROM assistant.runs r JOIN assistant.tasks t ON t.id=r.task_id WHERE r.id=${runId} AND r.workspace_id=${principal.workspace_id} AND r.vm_id=${principal.vm_id} AND r.state IN ('running','waiting') AND t.state IN ('running','waiting')`;
  if (principal.role !== "vm" || !rows[0])
    throw new DomainError("stale_run", "Owned active run required", 409);
  return z.object({ task_id: z.uuid() }).parse(rows[0]);
}

export async function records(
  sql: Query,
  principal: Principal,
  selection:
    | { readonly kind: "schedule" | "responsibility"; readonly id: string }
    | z.infer<typeof FutureWorkListInput>,
) {
  const target = "id" in selection ? selection : null;
  const filter = "query" in selection ? selection : null;
  const items: z.infer<typeof FutureWork>[] = [];
  if (!target || target.kind === "schedule") {
    const rows =
      await sql`SELECT s.* FROM assistant.schedules s WHERE s.workspace_id=${principal.workspace_id} AND (s.skill_id IS NULL OR EXISTS(SELECT 1 FROM assistant.extension_skills k WHERE k.id=s.skill_id AND k.workspace_id=s.workspace_id AND k.vm_id=${principal.vm_id})) ${target ? sql`AND s.id=${target.id} FOR UPDATE OF s` : sql`AND (${filter?.include_inactive ?? false} OR s.status='pending') AND position(lower(${filter?.query ?? ""}) IN lower(s.objective))>0 AND 'schedule:'||s.id::text>${filter?.cursor ?? ""} ORDER BY s.id LIMIT 11`}`;
    for (const raw of rows) {
      const row = Schedule.parse(raw);
      const configuration = ScheduleConfiguration.parse(row);
      const version = await hashToken(
        JSON.stringify([
          configuration,
          row.status,
          row.source_message_id,
          row.source_quote,
          row.skill_id,
          row.skill_revision,
          z.object({management_revision:z.number().int()}).parse(raw).management_revision,
        ]),
      );
      items.push({
        kind: "schedule",
        id: row.id,
        version,
        state: row.status,
        conversation_id: row.conversation_id,
        configuration,
        next_due_at: row.due_at,
        skill_id: row.skill_id,
        skill_revision: row.skill_revision,
      });
    }
  }
  if (!target || target.kind === "responsibility") {
    const rows =
      await sql`SELECT * FROM assistant.responsibilities WHERE workspace_id=${principal.workspace_id} AND vm_id=${principal.vm_id} ${target ? sql`AND id=${target.id} FOR UPDATE` : sql`AND (${filter?.include_inactive ?? false} OR state='active') AND position(lower(${filter?.query ?? ""}) IN lower(objective))>0 AND 'responsibility:'||id::text>${filter?.cursor ?? ""} ORDER BY id LIMIT 11`}`;
    for (const raw of rows) {
      const row = ResponsibilityRow.parse(raw);
      const configuration = ResponsibilityConfiguration.parse(row);
      const version = await hashToken(
        JSON.stringify([
          configuration,
          row.state,
          row.source_message_id,
          row.source_quote,
          row.skill_id,
          row.skill_revision,
          z.object({management_revision:z.number().int()}).parse(raw).management_revision,
        ]),
      );
      items.push({
        kind: "responsibility",
        id: row.id,
        version,
        state: row.state,
        conversation_id: row.conversation_id,
        configuration,
        next_due_at: row.next_review_at,
        skill_id: row.skill_id,
        skill_revision: row.skill_revision,
      });
    }
  }
  return items;
}
