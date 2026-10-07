import { ownedVersion } from "../../../packages/extensions/versions.ts";
import { Hono } from "hono";
import { z } from "zod";
import { DomainError, Id, Task } from "../../../packages/protocol";
import type { AppEnv } from "../auth";
import type { Database } from "../db";
import { conversation, recordEvent } from "../repository/common";

import { Schedule } from "../repository/schedule-enrollment";
import { memoryHistory, memoryViews } from "../../../packages/memory/views.ts";
import { Correction, correctMemory, deleteCorrection } from "../../../packages/memory/corrections.ts";

const Memory = z.object({
  id: Id,
  text: z.string(),
  source_message_id: Id.nullable(),
  created_at: z.string(),
});
export function personalRoutes(sql: Database) {
  const app = new Hono<AppEnv>();
  app.get("/schedules", async (c) =>
    c.json({
      schedules: z
        .array(Schedule.extend({ task: Task.nullable() }))
        .parse(
          await sql`SELECT s.*,CASE WHEN t.id IS NULL THEN NULL ELSE to_jsonb(t) END AS task
            FROM assistant.schedules s
            LEFT JOIN assistant.messages m ON m.workspace_id=s.workspace_id AND m.conversation_id=s.conversation_id AND m.client_message_id=s.id
            LEFT JOIN assistant.tasks t ON t.workspace_id=s.workspace_id AND t.id=m.task_id
            WHERE s.workspace_id=${c.get("principal").workspace_id} ORDER BY s.due_at DESC LIMIT 100`,
        ),
    }),
  );
  app.post("/schedules", async (c) => {
    const body = z
      .object({
        conversation_id: Id,
        objective: z.string().min(1).max(100000),
        due_at: z.iso.datetime({ offset: true }),
        timezone: z.string().min(1),
        client_schedule_id: Id,
        skill_id:Id.nullable().default(null),skill_revision:z.number().int().positive().nullable().default(null),
      })
      .parse(await c.req.json());
    try {
      new Intl.DateTimeFormat("en", { timeZone: body.timezone });
    } catch (error) {
      if (error instanceof RangeError)
        throw new DomainError("invalid_timezone", "Invalid IANA timezone");
      throw error;
    }
    const workspace = c.get("principal").workspace_id;
    const schedule = await sql.begin(async (tx) => {
      await conversation(tx, workspace, body.conversation_id);
      if((body.skill_id===null)!==(body.skill_revision===null))throw new DomainError("invalid_binding","Skill ID and revision required together",400);
      if(body.skill_id&&body.skill_revision)await ownedVersion(tx,workspace,body.skill_id,body.skill_revision);
      await tx`INSERT INTO assistant.schedules(workspace_id,conversation_id,objective,due_at,timezone,client_schedule_id,skill_id,skill_revision) VALUES(${workspace},${body.conversation_id},${body.objective},${body.due_at},${body.timezone},${body.client_schedule_id},${body.skill_id},${body.skill_revision}) ON CONFLICT(workspace_id,client_schedule_id) DO NOTHING`;
      const rows =
        await tx`SELECT * FROM assistant.schedules WHERE workspace_id=${workspace} AND client_schedule_id=${body.client_schedule_id}`;
      const schedule = Schedule.parse(rows[0]);
      if (
        schedule.conversation_id !== body.conversation_id ||
        schedule.objective !== body.objective ||
        Date.parse(schedule.due_at) !== Date.parse(body.due_at) ||
        schedule.timezone !== body.timezone || schedule.skill_id!==body.skill_id || schedule.skill_revision!==body.skill_revision
      )
        throw new DomainError("idempotency_conflict", "Schedule ID reused", 409);
      return schedule;
    });
    return c.json({ schedule });
  });
  app.delete("/schedules/:id", async (c) => {
    const rows =
      await sql`UPDATE assistant.schedules SET status=CASE WHEN status='pending' THEN 'cancelled' ELSE status END WHERE workspace_id=${c.get("principal").workspace_id} AND id=${Id.parse(c.req.param("id"))} RETURNING *`;
    if (!rows[0]) throw new DomainError("not_found", "Schedule not found", 404);
    return c.json({ schedule: Schedule.parse(rows[0]) });
  });
  app.get("/memory", async (c) =>
    c.json({
      memories: await memoryViews(sql,c.get("principal").workspace_id,{query:c.req.query("q")??""}),
    }),
  );
  app.get("/memory/:id/history",async c=>c.json({history:await memoryHistory(sql,c.get("principal").workspace_id,Id.parse(c.req.param("id")))}));
  app.post("/memory/:id/corrections",async c=>c.json({memory:await correctMemory(sql,c.get("principal"),{target:Id.parse(c.req.param("id")),body:Correction.parse(await c.req.json())})},201));
  app.post("/memory", async (c) => {
    const body = z
      .object({
        text: z.string().min(1).max(20000),
        source_message_id: Id.nullable().default(null),
      })
      .parse(await c.req.json());
    const workspace = c.get("principal").workspace_id;
    const memory = await sql.begin(async (tx) => {
      await tx`SELECT id FROM assistant.workspaces WHERE id=${workspace} FOR UPDATE`;
      if (body.source_message_id) {
        const source =
          await tx`SELECT id FROM assistant.messages WHERE workspace_id=${workspace} AND id=${body.source_message_id}`;
        if (!source[0]) throw new DomainError("not_found", "Source message not found", 404);
        const suppressed =
          await tx`SELECT 1 FROM assistant.memory_suppressions WHERE workspace_id=${workspace} AND source_message_id=${body.source_message_id}`;
        if (suppressed[0])
          throw new DomainError("source_suppressed", "Source was deleted from memory", 409);
      }
      const rows =
        await tx`INSERT INTO assistant.memories(workspace_id,text,source_message_id) VALUES(${workspace},${body.text},${body.source_message_id}) RETURNING *`;
      return Memory.parse(rows[0]);
    });
    return c.json({ memory }, 201);
  });
  app.delete("/memory/:id", async (c) => {
    const workspace = c.get("principal").workspace_id,
      id = Id.parse(c.req.param("id"));
    await sql.begin(async (tx) => {
      await tx`SELECT id FROM assistant.workspaces WHERE id=${workspace} FOR UPDATE`;
      if(await deleteCorrection(tx,workspace,id)){
        await recordEvent(tx,{workspace,kind:"memory.deleted",payload:JSON.stringify({id,scope:"correction_history"})});
        return;
      }
      const rows =
        await tx`UPDATE assistant.memories SET deleted_at=now() WHERE workspace_id=${workspace} AND id=${id} RETURNING *`;
      if (!rows[0]) throw new DomainError("not_found", "Memory not found", 404);
      const memory = Memory.parse(rows[0]);
      if (memory.source_message_id) {
        await tx`INSERT INTO assistant.memory_suppressions(workspace_id,source_message_id) VALUES(${workspace},${memory.source_message_id}) ON CONFLICT DO NOTHING`;
        await tx`UPDATE assistant.memories SET deleted_at=now() WHERE workspace_id=${workspace} AND source_message_id=${memory.source_message_id}`;
      }
      await recordEvent(tx, { workspace, kind: "memory.deleted", payload: JSON.stringify({ id }) });
    });
    return c.json({ deleted: true });
  });
  return app;
}
