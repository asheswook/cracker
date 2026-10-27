/**
 * The one place that decides what a run may use (the daemon enforces it on offer and again before each call).
 * - send_once: a dedicated send or check (no model tools).
 * - read_only: an assistant-owned look or reply draft (fixed readers of its own account only).
 * - brief: the morning brief or meeting prep (reads prior work and the bound calendar; never sends, posts or browses).
 * Everything else keeps the tools it has today (registered routines and the user's own requests); see the plan:
 * routines move to fixed adapters before they are narrowed.
 */
import { isBriefTask } from "../../../packages/attention/coordinator";
import { sourceRunPolicy, sourceScope } from "../../../packages/attention/sources";
import type { Query } from "../db";

export async function executionPolicy(sql: Query, workspace: string, task: string) {
  const source = await sourceRunPolicy(sql, workspace, task);
  if (source === 'read_only') {
    const scope = await sourceScope(sql, workspace, task);
    return { run_policy: 'read_only' as const, ...(scope ? { source_scope: scope } : {}) };
  }
  if (source) return { run_policy: source };
  if (await isBriefTask(sql, workspace, task)) { // Includes meeting_preps.task_id, even after publication/skip.
    // Calendar reads come only from the server bound for the brief, at the configuration revision it was bound at.
    const calendars = (await sql`SELECT e.id FROM assistant.attention_settings a JOIN assistant.extension_servers e ON e.id=a.brief_calendar_server
      WHERE a.workspace_id=${workspace} AND e.workspace_id=${workspace} AND e.enabled AND e.revision=a.brief_calendar_revision`).map(r => String(r['id']));
    return { run_policy: 'brief' as const, calendar_servers: calendars };
  }
  return {};
}
