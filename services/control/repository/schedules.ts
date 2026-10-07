import { bindSkill } from "../../../packages/extensions/versions.ts";
import { z } from "zod";
import type { Database } from "../db";
import { appendMessage, conversation } from "./common";
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
        await tx`SELECT s.* FROM assistant.schedules s WHERE s.status='pending' AND s.due_at<=now() AND (s.skill_id IS NULL OR NOT EXISTS(SELECT 1 FROM assistant.tasks t WHERE t.conversation_id=s.conversation_id AND t.state NOT IN ('cancelled','succeeded','failed'))) ORDER BY s.due_at LIMIT 100 FOR UPDATE OF s SKIP LOCKED`,
      );
    let dispatched=0;
    for (const schedule of due) {
      await conversation(tx,schedule.workspace_id,schedule.conversation_id);
      if(schedule.skill_id&&(await tx`SELECT id FROM assistant.tasks WHERE conversation_id=${schedule.conversation_id} AND state NOT IN ('cancelled','succeeded','failed') LIMIT 1`)[0])continue;
      const created=await appendMessage(tx, {
        workspace: schedule.workspace_id,
        conversation: schedule.conversation_id,
        content: schedule.objective,
        clientId: schedule.id,
        role: "system",
      });
      if(schedule.skill_id&&schedule.skill_revision)await bindSkill(tx,{workspace:schedule.workspace_id,task:created.task.id,message:created.message.id,skill:schedule.skill_id,revision:schedule.skill_revision,kind:"scheduled"});
      await tx`UPDATE assistant.schedules SET status='delivered',delivered_at=now() WHERE id=${schedule.id}`;
      dispatched++;
    }
    return dispatched;
  });
}
