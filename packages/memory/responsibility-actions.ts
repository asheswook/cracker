import { bindSkill } from "../extensions/versions.ts";
import { z } from "zod";
import type { Principal } from "../../services/control/auth.ts";
import type { Transaction } from "../../services/control/db.ts";
import { createBackgroundTask, recordEvent } from "../../services/control/repository/common.ts";
import { ResponsibilityRow, snapshot } from "./responsibility-store.ts";
export async function dispatchActions(tx: Transaction, principal: Principal): Promise<void> {
  await tx`UPDATE assistant.responsibility_actions a SET state='cancelled' FROM assistant.responsibilities r WHERE r.id=a.responsibility_id AND r.workspace_id=${principal.workspace_id} AND r.vm_id=${principal.vm_id} AND r.until_at<=now() AND a.state='pending'`;
  const pending = await tx`SELECT a.id AS action_id,a.objective AS action_objective,a.context_hash AS action_context_hash,r.* FROM assistant.responsibility_actions a JOIN assistant.responsibilities r ON r.id=a.responsibility_id WHERE r.workspace_id=${principal.workspace_id} AND r.vm_id=${principal.vm_id} AND r.state='active' AND a.state='pending' ORDER BY a.created_at LIMIT 20 FOR UPDATE OF a`;
  for (const raw of pending) {
    const row = ResponsibilityRow.extend({ action_id: z.uuid(), action_objective: z.string(), action_context_hash: z.string() }).parse(raw);
    if (row.until_at && new Date(row.until_at).getTime() <= Date.now()) {
      await tx`UPDATE assistant.responsibility_actions SET state='cancelled' WHERE id=${row.action_id}`;
      continue;
    }
    await tx`SELECT id FROM assistant.conversations WHERE id=${row.conversation_id} FOR UPDATE`;
    if (row.trigger.kind !== "daily" && (await snapshot(tx, row)).context_hash !== row.action_context_hash) {
      await tx`UPDATE assistant.responsibility_actions SET state='cancelled' WHERE id=${row.action_id}`;
      continue;
    }
    const {task,message}=await createBackgroundTask(tx,{workspace:principal.workspace_id,conversation:row.conversation_id,objective:row.action_objective,title:row.title,origin:'responsibility',clientId:row.action_id});
    if(row.skill_id&&row.skill_revision)await bindSkill(tx,{workspace:principal.workspace_id,task:task.id,message:message.id,skill:row.skill_id,revision:row.skill_revision,kind:'scheduled'});
    await tx`UPDATE assistant.responsibility_actions SET state='dispatched',task_id=${task.id},dispatched_at=now() WHERE id=${row.action_id}`;
    await recordEvent(tx, { workspace: principal.workspace_id, kind: "responsibility.dispatched", payload: JSON.stringify({ responsibility_id: row.id, action_id: row.action_id, task_id: task.id }) });
  }
}
