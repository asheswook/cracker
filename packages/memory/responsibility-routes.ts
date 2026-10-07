import { Hono } from "hono";
import { z } from "zod";
import type { AppEnv } from "../../services/control/auth.ts";
import type { Database } from "../../services/control/db.ts";
import { recordEvent } from "../../services/control/repository/common.ts";
import { DomainError } from "../protocol/index.ts";
import { EvaluationRequest, ResponsibilityInput, QuietHours, Trigger } from "./responsibility-schema.ts";
import { nextDailyAt } from "./daily-work.ts";
import { listResponsibilities } from "./responsibility-list.ts";
import { ResponsibilityHistoryQuery } from "./responsibility-history-schema.ts";
import { responsibilityHistory } from "./responsibility-history-store.ts";
import { ResponsibilityRow, createResponsibility, dueResponsibilities, recordEvaluation } from "./responsibility-store.ts";
export function responsibilityClientRoutes(sql: Database): Hono<AppEnv> {
  const app = new Hono<AppEnv>();
  app.post("/", async c => c.json({ responsibility: await createResponsibility(sql, c.get("principal"), ResponsibilityInput.parse(await c.req.json())) }, 201));
  app.get("/", async c => c.json({ responsibilities: await listResponsibilities(sql,c.get("principal").workspace_id) }));
  app.get("/:id/history", async c => c.json(await responsibilityHistory(
    sql, c.get("principal").workspace_id, z.uuid().parse(c.req.param("id")),
    ResponsibilityHistoryQuery.parse(c.req.query()),
  )));
  app.put("/:id/schedule",async c=>{
    const id=z.uuid().parse(c.req.param("id")),workspace=c.get("principal").workspace_id;
    const body=z.object({trigger:Trigger,source_message_id:z.uuid(),source_quote:z.string().min(1).max(10000)}).strict().parse(await c.req.json());
    const result=await sql.begin(async tx=>{
      await tx`SELECT id FROM assistant.workspaces WHERE id=${workspace} FOR UPDATE`;
      const rows=await tx`SELECT * FROM assistant.responsibilities WHERE id=${id} AND workspace_id=${workspace} AND state='active' FOR UPDATE`;
      if(!rows[0])throw new DomainError("not_found","Active responsibility not found",404);
      const row=ResponsibilityRow.parse(rows[0]);
      const source=await tx`SELECT id FROM assistant.messages WHERE id=${body.source_message_id} AND workspace_id=${workspace} AND conversation_id=${row.conversation_id} AND role='user' AND position(${body.source_quote} IN content)>0`;
      if(!source[0])throw new DomainError("source_mismatch","User request not found",400);
      if(body.trigger.kind==='task_change'&&!(await tx`SELECT id FROM assistant.tasks WHERE id=${body.trigger.task_id} AND workspace_id=${workspace} AND conversation_id=${row.conversation_id}`)[0])throw new DomainError("not_found","Trigger task not found",404);
      const due=body.trigger.kind==='daily'?await nextDailyAt(tx,body.trigger,new Date().toISOString()):body.trigger.kind==='deadline'?body.trigger.due_at:new Date().toISOString();
      await tx`UPDATE assistant.responsibility_actions SET state='cancelled' WHERE responsibility_id=${id} AND state='pending'`;
      await tx`UPDATE assistant.responsibility_notifications SET state='cancelled' WHERE responsibility_id=${id} AND state='pending'`;
      const updated=ResponsibilityRow.parse((await tx`UPDATE assistant.responsibilities SET trigger=${JSON.stringify(body.trigger)}::text::jsonb,source_message_id=${body.source_message_id},source_quote=${body.source_quote},next_review_at=${due},failure_count=0,last_error=NULL,management_revision=management_revision+1 WHERE id=${id} RETURNING *`)[0]);
      await recordEvent(tx,{workspace,kind:'responsibility.schedule_updated',payload:JSON.stringify({responsibility_id:id,trigger:body.trigger,source_message_id:body.source_message_id})});
      return updated;
    });
    return c.json({responsibility:result});
  });
  app.delete("/:id", async c => {
    const id = z.uuid().parse(c.req.param("id")), workspace = c.get("principal").workspace_id;
    await sql.begin(async tx => {
      await tx`SELECT id FROM assistant.workspaces WHERE id=${workspace} FOR UPDATE`;
      const rows = await tx`UPDATE assistant.responsibilities SET state='cancelled' WHERE id=${id} AND workspace_id=${workspace} RETURNING id`;
      if (!rows[0]) throw new DomainError("not_found", "Responsibility not found", 404);
      await tx`UPDATE assistant.responsibility_notifications SET state='cancelled' WHERE responsibility_id=${id} AND state='pending'`;
      await tx`UPDATE assistant.responsibility_actions SET state='cancelled' WHERE responsibility_id=${id} AND state='pending'`;
      await recordEvent(tx, { workspace, kind: "responsibility.cancelled", payload: JSON.stringify({ responsibility_id: id }) });
    });
    return c.json({ cancelled: true });
  });
  app.post("/:id/settings", async c => {
    const id = z.uuid().parse(c.req.param("id")), workspace = c.get("principal").workspace_id;
    const settings = z.object({ notification_mode: z.enum(["enabled", "quiet"]), quiet_hours: QuietHours.nullable() }).parse(await c.req.json());
    await sql.begin(async tx => {
      await tx`SELECT id FROM assistant.workspaces WHERE id=${workspace} FOR UPDATE`;
      const rows = await tx`UPDATE assistant.responsibilities SET notification_mode=${settings.notification_mode},quiet_hours=${JSON.stringify(settings.quiet_hours)}::text::jsonb,next_review_at=CASE WHEN trigger->>'kind'='daily' THEN next_review_at ELSE now() END,management_revision=management_revision+1 WHERE id=${id} AND workspace_id=${workspace} RETURNING id`;
      if (!rows[0]) throw new DomainError("not_found", "Responsibility not found", 404);
    });
    return c.json({ updated: true });
  });
  app.post("/:id/trigger", async c => {
    const id = z.uuid().parse(c.req.param("id")), workspace = c.get("principal").workspace_id;
    const source = z.object({ source_message_id: z.uuid() }).parse(await c.req.json());
    const rows = await sql`UPDATE assistant.responsibilities r SET next_review_at=now(),failure_count=0 WHERE r.id=${id} AND r.workspace_id=${workspace} AND r.state='active' AND EXISTS(SELECT 1 FROM assistant.messages m WHERE m.id=${source.source_message_id} AND m.workspace_id=r.workspace_id AND m.conversation_id=r.conversation_id AND m.role='user') RETURNING r.id`;
    if (!rows[0]) throw new DomainError("not_found", "Active responsibility or user event not found", 404);
    return c.json({ triggered: true });
  });
  return app;
}
export function responsibilityDaemonRoutes(sql: Database): Hono<AppEnv> {
  const app = new Hono<AppEnv>();
  app.post("/", async c => {
    const principal = c.get("principal");
    const request = ResponsibilityInput.omit({ vm_id: true }).extend({ run_id: z.uuid() }).parse(await c.req.json());
    const input = { ...request, vm_id: z.uuid().parse(principal.vm_id) };
    return c.json({ responsibility: await createResponsibility(sql, principal, input) }, 201);
  });
  app.get("/", async c => c.json({ responsibilities: await dueResponsibilities(sql, c.get("principal")) }));
  app.post("/evaluate", async c => { await recordEvaluation(sql, c.get("principal"), EvaluationRequest.parse(await c.req.json())); return c.json({ accepted: true }); });
  app.post("/failure", async c => {
    const request = z.object({ responsibility_id: z.uuid(), error_code: z.enum(["provider_error", "invalid_output", "stale_evidence"]) }).parse(await c.req.json());
    const principal = c.get("principal");
    const rows = await sql`UPDATE assistant.responsibilities SET failure_count=CASE WHEN trigger->>'kind'='daily' THEN failure_count ELSE failure_count+1 END,last_error=CASE WHEN trigger->>'kind'='daily' THEN last_error ELSE ${request.error_code} END,next_review_at=CASE WHEN trigger->>'kind'='daily' THEN next_review_at ELSE now()+least(60,power(2,least(failure_count,5)))*interval '1 minute' END WHERE id=${request.responsibility_id} AND workspace_id=${principal.workspace_id} AND vm_id=${principal.vm_id} AND state='active' RETURNING id,trigger->>'kind' AS trigger_kind`;
    if (!rows[0]) throw new DomainError("not_found", "Active responsibility not found", 404);
    return c.json({ retry_scheduled: z.object({trigger_kind:z.string()}).parse(rows[0]).trigger_kind !== "daily" });
  });
  return app;
}
