import { ownedVersion } from "../../../packages/extensions/versions.ts";
import { z } from "zod";
import { DomainError, Id } from "../../../packages/protocol";
import type { Principal } from "../auth";
import type { Database } from "../db";
import { conversation, recordEvent } from "./common";
import { loadRun } from "./runs";

export const ScheduleRequest = z.object({
  run_id: Id,
  client_schedule_id: Id,
  objective: z.string().trim().min(1).max(100000),
  title: z.string().trim().max(60).nullable().default(null),
  due_at: z.iso.datetime({ offset: true }),
  timezone: z.string().min(1).max(100),
  source_message_id: Id,
  source_quote: z.string().trim().min(1).max(100000),
  skill_id:Id.nullable().default(null),skill_revision:z.number().int().positive().nullable().default(null),
});
export const Schedule = z.object({
  title: z.string().nullable().default(null),
  id: Id,
  conversation_id: Id,
  objective: z.string(),
  due_at: z.string(),
  timezone: z.string(),
  client_schedule_id: Id,
  status: z.enum(["pending", "delivered", "cancelled"]),
  created_at: z.string(),
  source_message_id: Id.nullable(),
  source_quote: z.string().nullable(),
  skill_id:Id.nullable().default(null),skill_revision:z.number().int().positive().nullable().default(null),
});
export async function enrollSchedule(
  sql: Database,
  principal: Principal,
  body: z.infer<typeof ScheduleRequest>,
) {
  if (principal.role !== "vm") throw new DomainError("forbidden", "VM credential required", 403);
  try {
    new Intl.DateTimeFormat("en", { timeZone: body.timezone });
  } catch (error) {
    if (error instanceof RangeError)
      throw new DomainError("invalid_timezone", "Invalid IANA timezone");
    throw error;
  }
  return sql.begin(async (tx) => {
    const workspace = principal.workspace_id;
    await tx`SELECT id FROM assistant.workspaces WHERE id=${workspace} FOR UPDATE`;
    const run = await loadRun(tx, principal, body.run_id);
    const task = z
      .object({ conversation_id: Id, state: z.string() })
      .parse(
        (await tx`SELECT conversation_id,state FROM assistant.tasks WHERE id=${run.task_id}`)[0],
      );
    if (!["running", "waiting"].includes(run.state) || !["running", "waiting"].includes(task.state))
      throw new DomainError("stale_run", "Active owned run required", 409);
    await conversation(tx, workspace, task.conversation_id);
    const sources =
      await tx`SELECT content FROM assistant.messages WHERE workspace_id=${workspace} AND conversation_id=${task.conversation_id} AND id=${body.source_message_id} AND role='user'`;
    if (
      !sources[0] ||
      !z.object({ content: z.string() }).parse(sources[0]).content.includes(body.source_quote)
    )
      throw new DomainError("invalid_source", "Exact user source quote required", 409);
    if((body.skill_id===null)!==(body.skill_revision===null))throw new DomainError("invalid_binding","Skill ID and revision required together",400);
    if(body.skill_id&&body.skill_revision)await ownedVersion(tx,workspace,body.skill_id,body.skill_revision,principal.vm_id??undefined);
    const prior =
      await tx`SELECT * FROM assistant.schedules WHERE workspace_id=${workspace} AND client_schedule_id=${body.client_schedule_id}`;
    if (prior[0]) {
      const saved = Schedule.parse(prior[0]);
      if (
        saved.conversation_id !== task.conversation_id ||
        saved.objective !== body.objective ||
        Date.parse(saved.due_at) !== Date.parse(body.due_at) ||
        saved.timezone !== body.timezone ||
        saved.source_message_id !== body.source_message_id ||
        saved.source_quote !== body.source_quote || saved.skill_id!==body.skill_id || saved.skill_revision!==body.skill_revision
      )
        throw new DomainError("idempotency_conflict", "Schedule action key reused", 409);
      return saved;
    }
    const saved = Schedule.parse(
      (
        await tx`INSERT INTO assistant.schedules(title,workspace_id,conversation_id,objective,due_at,timezone,client_schedule_id,source_message_id,source_quote,skill_id,skill_revision) VALUES(${body.title || null},${workspace},${task.conversation_id},${body.objective},${body.due_at},${body.timezone},${body.client_schedule_id},${body.source_message_id},${body.source_quote},${body.skill_id},${body.skill_revision}) RETURNING *`
      )[0],
    );
    await recordEvent(tx, {
      workspace,
      kind: "schedule.created",
      payload: JSON.stringify({ schedule: saved }),
    });
    return saved;
  });
}
