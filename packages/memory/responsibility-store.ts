import { enqueueMessageNotification } from "../notifications/store.ts";
import { ownedVersion } from "../extensions/versions.ts";
import { dispatchActions } from "./responsibility-actions.ts";
import { enqueueDaily, nextDailyAt } from "./daily-work.ts";
import { z } from "zod";
import type { Principal } from "../../services/control/auth.ts";
import type { Database, Query, Transaction } from "../../services/control/db.ts";
import { DomainError } from "../protocol/index.ts";
import { hashToken } from "../../services/control/auth.ts";
import { recordEvent } from "../../services/control/repository/common.ts";
import { fenceRun } from '../../services/control/repository/daemon-session';
import { QuietHours, Trigger, type ResponsibilitySnapshot, ResponsibilityInput, type EvaluationRequest, quietNow } from "./responsibility-schema.ts";
export const ResponsibilityRow = z.object({ title: z.string().nullable().default(null), skill_id:z.uuid().nullable().default(null),skill_revision:z.number().int().positive().nullable().default(null), id: z.uuid(), workspace_id: z.uuid(), conversation_id: z.uuid(), vm_id: z.uuid(), client_responsibility_id: z.uuid(), source_message_id: z.uuid(), source_quote: z.string(), objective: z.string(), trigger: Trigger, notification_mode: z.enum(["enabled", "quiet"]), quiet_hours: QuietHours.nullable(), state: z.enum(["active", "complete", "cancelled"]), next_review_at: z.string() });
export async function createResponsibility(sql: Database, principal: Principal, input: ResponsibilityInput & { readonly run_id?: string }) {
  return sql.begin(async tx => {
    await tx`SELECT id FROM assistant.workspaces WHERE id=${principal.workspace_id} FOR UPDATE`;
    await fenceRun(tx,principal,input.run_id);
    if (input.run_id) {
      const owned = await tx`SELECT r.id FROM assistant.runs r JOIN assistant.tasks t ON t.id=r.task_id JOIN assistant.messages m ON m.task_id=t.id WHERE r.id=${input.run_id} AND r.workspace_id=${principal.workspace_id} AND r.vm_id=${principal.vm_id} AND t.conversation_id=${input.conversation_id} AND r.state IN ('running','waiting') AND t.state IN ('running','waiting') AND m.id=${input.source_message_id} AND m.role='user' FOR UPDATE OF r,t`;
      if (!owned[0] || principal.vm_id !== input.vm_id) throw new DomainError("stale_run", "Owned active run and current user source required", 409);
    }
    const source = await tx`SELECT id FROM assistant.messages WHERE workspace_id=${principal.workspace_id} AND conversation_id=${input.conversation_id} AND id=${input.source_message_id} AND role='user' AND position(${input.source_quote} IN content)>0`;
    const vm = await tx`SELECT id FROM assistant.vms WHERE id=${input.vm_id} AND workspace_id=${principal.workspace_id}`;
    if (!source[0] || !vm[0]) throw new DomainError("source_mismatch", "Explicit user source and owned VM required", 400);
    if (input.trigger.kind === "task_change" && !(await tx`SELECT id FROM assistant.tasks WHERE id=${input.trigger.task_id} AND workspace_id=${principal.workspace_id} AND conversation_id=${input.conversation_id}`)[0]) throw new DomainError("not_found", "Trigger task not found", 404);
    if((input.skill_id===null)!==(input.skill_revision===null))throw new DomainError("invalid_binding","Skill ID and revision required together",400);
    if(input.skill_id&&input.skill_revision)await ownedVersion(tx,principal.workspace_id,input.skill_id,input.skill_revision,input.vm_id);
    const prior = await tx`SELECT * FROM assistant.responsibilities WHERE workspace_id=${principal.workspace_id} AND client_responsibility_id=${input.client_responsibility_id}`;
    if (prior[0]) {
      const existing = ResponsibilityRow.parse(prior[0]);
      const identity = ResponsibilityInput.omit({ title: true });
      if (JSON.stringify(identity.parse(existing)) !== JSON.stringify(identity.parse(input))) throw new DomainError("idempotency_conflict", "Responsibility key reused", 409);
      return existing;
    }
    const due = input.trigger.kind === "deadline" ? input.trigger.due_at : input.trigger.kind === "daily" ? await nextDailyAt(tx,input.trigger,new Date().toISOString()) : new Date().toISOString();
    const created = ResponsibilityRow.parse((await tx`INSERT INTO assistant.responsibilities(title,workspace_id,conversation_id,vm_id,client_responsibility_id,source_message_id,source_quote,objective,trigger,notification_mode,quiet_hours,next_review_at,skill_id,skill_revision) VALUES(${input.title || null},${principal.workspace_id},${input.conversation_id},${input.vm_id},${input.client_responsibility_id},${input.source_message_id},${input.source_quote},${input.objective},${JSON.stringify(input.trigger)}::text::jsonb,${input.notification_mode},${JSON.stringify(input.quiet_hours)}::text::jsonb,${due},${input.skill_id},${input.skill_revision}) RETURNING *`)[0]);
    await recordEvent(tx, { workspace: principal.workspace_id, kind: "responsibility.created", payload: JSON.stringify({ responsibility_id: created.id }) });
    return created;
  });
}
export async function snapshot(sql: Query, row: z.infer<typeof ResponsibilityRow>): Promise<ResponsibilitySnapshot> {
  const messages = z.array(z.object({ id: z.uuid(), role: z.string(), content: z.string(), created_at: z.string() })).parse(await sql`SELECT m.id,m.role,m.content,m.created_at FROM assistant.messages m WHERE m.workspace_id=${row.workspace_id} AND m.conversation_id=${row.conversation_id} AND NOT EXISTS(SELECT 1 FROM assistant.responsibility_notifications n WHERE n.message_id=m.id) ORDER BY m.sequence DESC LIMIT 100`);
  const tasks = z.array(z.object({ id: z.uuid(), objective: z.string(), state: z.string(), reason: z.string().nullable() })).parse(await sql`SELECT id,objective,state,reason FROM assistant.tasks WHERE workspace_id=${row.workspace_id} AND conversation_id=${row.conversation_id} ORDER BY id FOR SHARE`);
  // Periodic watches observe the outside world, which is not in the conversation: each interval is a new occurrence.
  const occurrence = row.trigger.kind === "periodic" ? Math.floor(Date.now() / (row.trigger.interval_minutes * 60_000)) : null;
  const context_hash = await hashToken(JSON.stringify({ objective: row.objective, trigger: row.trigger, messages, tasks, ...(occurrence === null ? {} : { occurrence }) }));
  const history = z.array(z.object({ outcome: z.string(), reason: z.string() })).parse(await sql`SELECT outcome,reason FROM assistant.responsibility_evaluations WHERE responsibility_id=${row.id} ORDER BY created_at DESC LIMIT 5`);
  const notifications = z.array(z.object({ state: z.string(), content: z.string() })).parse(await sql`SELECT state,content FROM assistant.responsibility_notifications WHERE responsibility_id=${row.id} ORDER BY created_at DESC LIMIT 5`);
  return { history, notifications, id: row.id, objective: row.objective, trigger: row.trigger, context_hash, messages, tasks };
}
export async function dueResponsibilities(sql: Database, principal: Principal): Promise<readonly ResponsibilitySnapshot[]> {
  return sql.begin(async tx => {
    await tx`SELECT id FROM assistant.workspaces WHERE id=${principal.workspace_id} FOR UPDATE`;
    await fenceRun(tx,principal);
    await dispatchActions(tx, principal);
    await deliverNotifications(tx, principal);
    const rows = z.array(ResponsibilityRow).parse(await tx`SELECT * FROM assistant.responsibilities WHERE workspace_id=${principal.workspace_id} AND vm_id=${principal.vm_id} AND state='active' AND (next_review_at<=now() OR (trigger->>'kind'='task_change' AND failure_count=0)) ORDER BY next_review_at LIMIT 10 FOR UPDATE`);
    const pending: ResponsibilitySnapshot[] = [];
    for (const row of rows) {
      if(row.trigger.kind==="daily"){await enqueueDaily(tx,{...row,trigger:row.trigger});continue;}
      const current = await snapshot(tx, row);
      if ((await tx`SELECT id FROM assistant.responsibility_evaluations WHERE workspace_id=${principal.workspace_id} AND responsibility_id=${row.id} AND context_hash=${current.context_hash}`)[0]) {
        await tx`UPDATE assistant.responsibilities SET next_review_at=now()+interval '5 minutes' WHERE id=${row.id}`;
      } else pending.push(current);
    }
    await dispatchActions(tx,principal);
    return pending;
  });
}
export async function recordEvaluation(sql: Database, principal: Principal, request: EvaluationRequest): Promise<void> {
  await sql.begin(async tx => {
    await tx`SELECT id FROM assistant.workspaces WHERE id=${principal.workspace_id} FOR UPDATE`;
    await fenceRun(tx,principal);
    const found = await tx`SELECT * FROM assistant.responsibilities WHERE workspace_id=${principal.workspace_id} AND vm_id=${principal.vm_id} AND id=${request.responsibility_id} FOR UPDATE`;
    if (!found[0]) throw new DomainError("not_found", "Responsibility not found", 404);
    const row = ResponsibilityRow.parse(found[0]);
    if (row.trigger.kind === "daily") throw new DomainError("stale_evaluation", "Daily work does not accept model evaluations", 409);
    await tx`SELECT id FROM assistant.conversations WHERE id=${row.conversation_id} FOR UPDATE`;
    const prior = await tx`SELECT id FROM assistant.responsibility_evaluations WHERE workspace_id=${principal.workspace_id} AND responsibility_id=${row.id} AND context_hash=${request.context_hash}`;
    if (prior[0]) return;
    if (row.state !== "active") throw new DomainError("inactive", "Responsibility is inactive", 409);
    if ((await snapshot(tx, row)).context_hash !== request.context_hash) throw new DomainError("stale_evaluation", "Evidence changed during evaluation", 409);
    const evaluation = request.evaluation;
    await tx`INSERT INTO assistant.responsibility_evaluations(workspace_id,responsibility_id,context_hash,outcome,reason) VALUES(${principal.workspace_id},${row.id},${request.context_hash},${evaluation.outcome},${evaluation.reason})`;
    await tx`UPDATE assistant.responsibilities SET state=${evaluation.outcome === "complete" ? "complete" : "active"},last_evaluated_at=now(),last_context_hash=${request.context_hash},next_review_at=now()+${evaluation.next_review_minutes}*interval '1 minute',failure_count=0,last_error=NULL WHERE id=${row.id}`;
    if (evaluation.outcome === "notify" && evaluation.notification) await tx`INSERT INTO assistant.responsibility_notifications(workspace_id,responsibility_id,context_hash,content) VALUES(${principal.workspace_id},${row.id},${request.context_hash},${evaluation.notification}) ON CONFLICT DO NOTHING`;
    if (evaluation.outcome === "action" && evaluation.action_objective) await tx`INSERT INTO assistant.responsibility_actions(workspace_id,responsibility_id,context_hash,objective) VALUES(${principal.workspace_id},${row.id},${request.context_hash},${evaluation.action_objective}) ON CONFLICT DO NOTHING`;
    await dispatchActions(tx, principal);
    await recordEvent(tx, { workspace: principal.workspace_id, kind: "responsibility.evaluated", payload: JSON.stringify({ responsibility_id: row.id, outcome: evaluation.outcome, context_hash: request.context_hash }) });
    await deliverNotifications(tx, principal);
  });
}
async function deliverNotifications(tx: Transaction, principal: Principal): Promise<void> {
  const rows = await tx`SELECT n.id AS notification_id,n.content,n.context_hash AS notification_context_hash,r.* FROM assistant.responsibility_notifications n JOIN assistant.responsibilities r ON r.id=n.responsibility_id WHERE r.workspace_id=${principal.workspace_id} AND r.vm_id=${principal.vm_id} AND r.state<>'cancelled' AND n.state='pending' ORDER BY n.created_at LIMIT 50 FOR UPDATE OF n`;
  for (const raw of rows) {
    const row = ResponsibilityRow.extend({ notification_id: z.uuid(), content: z.string(), notification_context_hash: z.string() }).parse(raw);
    if ((await snapshot(tx, row)).context_hash !== row.notification_context_hash) {
      await tx`UPDATE assistant.responsibility_notifications SET state='cancelled' WHERE id=${row.notification_id}`;
      await recordEvent(tx, { workspace: principal.workspace_id, kind: "responsibility.notification_superseded", payload: JSON.stringify({ notification_id: row.notification_id }) });
      continue;
    }
    if (row.notification_mode === "quiet" || quietNow(row.quiet_hours, new Date())) continue;
    const message = z.object({ id: z.uuid() }).parse((await tx`INSERT INTO assistant.messages(workspace_id,conversation_id,role,content,origin,notify) VALUES(${principal.workspace_id},${row.conversation_id},'assistant',${row.content},'responsibility',true) RETURNING id`)[0]);
    await enqueueMessageNotification(tx, principal.workspace_id, message);
    await tx`UPDATE assistant.responsibility_notifications SET state='delivered',message_id=${message.id},delivered_at=now() WHERE id=${row.notification_id}`;
    await recordEvent(tx, { workspace: principal.workspace_id, kind: "responsibility.notified", payload: JSON.stringify({ responsibility_id: row.id, message_id: message.id }) });
  }
}
