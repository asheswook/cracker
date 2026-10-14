import { bindSkill } from "../../../packages/extensions/versions.ts";
import { z } from "zod";
import type { Database } from "../db";
import { createBackgroundTask } from "./common";
export async function dispatchDueSchedules(sql: Database): Promise<number> {
  return sql.begin(async (tx) => {
    const due = z
      .array(
        z.object({
          id: z.uuid(),
          workspace_id: z.uuid(),
          conversation_id: z.uuid(),
          objective: z.string(),skill_id:z.uuid().nullable(),skill_revision:z.number().int().nullable(),
        }),
      )
      .parse(
        await tx`SELECT s.* FROM assistant.schedules s WHERE s.status='pending' AND s.due_at<=now() ORDER BY s.due_at LIMIT 100 FOR UPDATE OF s SKIP LOCKED`,
      );
    let dispatched=0;
    for (const schedule of due) {
      const created=await createBackgroundTask(tx, {
        workspace: schedule.workspace_id,
        conversation: schedule.conversation_id,
        objective: schedule.objective,
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
