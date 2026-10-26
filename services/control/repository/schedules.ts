import { bindSkill } from "../../../packages/extensions/versions.ts";
import { z } from "zod";
import type { Database } from "../db";
import { createBackgroundTask } from "./common";
export async function dispatchDueSchedules(sql: Database): Promise<number> {
  return sql.begin(async (tx) => {
    const workspaces=z.array(z.object({id:z.uuid()})).parse(await tx`SELECT w.id FROM assistant.workspaces w WHERE EXISTS(
      SELECT 1 FROM assistant.schedules s WHERE s.workspace_id=w.id AND s.status='pending' AND s.due_at<=now()) ORDER BY w.id FOR KEY SHARE OF w SKIP LOCKED`);
    if(!workspaces.length)return 0;
    await tx`SELECT v.id FROM assistant.vms v WHERE v.workspace_id=ANY(${tx.array(workspaces.map(workspace=>workspace.id))}::uuid[]) AND EXISTS(
      SELECT 1 FROM assistant.schedules s JOIN assistant.extension_skills k ON k.id=s.skill_id AND k.workspace_id=s.workspace_id
      WHERE s.workspace_id=v.workspace_id AND k.vm_id=v.id AND s.status='pending' AND s.due_at<=now()) ORDER BY v.id FOR KEY SHARE OF v`;
    const due = z
      .array(
        z.object({
          id: z.uuid(),
          workspace_id: z.uuid(),
          conversation_id: z.uuid(),
          objective: z.string(),skill_id:z.uuid().nullable(),skill_revision:z.number().int().nullable(),
          title: z.string().nullable(),
        }),
      )
      .parse(
        await tx`SELECT s.* FROM assistant.schedules s WHERE s.workspace_id=ANY(${tx.array(workspaces.map(workspace=>workspace.id))}::uuid[]) AND s.status='pending' AND s.due_at<=now() ORDER BY s.due_at,s.id LIMIT 100 FOR UPDATE OF s SKIP LOCKED`,
      );
    let dispatched=0;
    for (const schedule of due) {
      const created=await createBackgroundTask(tx, {
        workspace: schedule.workspace_id,
        conversation: schedule.conversation_id,
        objective: schedule.objective,
        title: schedule.title,
        clientId: schedule.id,
        origin: "schedule",
      });
      if(schedule.skill_id&&schedule.skill_revision)await bindSkill(tx,{workspace:schedule.workspace_id,task:created.task.id,message:created.message.id,skill:schedule.skill_id,revision:schedule.skill_revision,kind:"scheduled"});
      await tx`UPDATE assistant.schedules SET status='delivered',delivered_at=now() WHERE id=${schedule.id}`;
      dispatched++;
    }
    return dispatched;
  });
}
