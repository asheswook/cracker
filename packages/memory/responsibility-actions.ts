import { bindSkill } from "../extensions/versions.ts";
import { z } from "zod";
import type { Principal } from "../../services/control/auth.ts";
import type { Transaction } from "../../services/control/db.ts";
import { recordEvent } from "../../services/control/repository/common.ts";
import { ResponsibilityRow, snapshot } from "./responsibility-store.ts";
export async function dispatchActions(tx: Transaction, principal: Principal): Promise<void> {
  const pending = await tx`SELECT a.id AS action_id,a.objective AS action_objective,a.context_hash AS action_context_hash,r.* FROM assistant.responsibility_actions a JOIN assistant.responsibilities r ON r.id=a.responsibility_id WHERE r.workspace_id=${principal.workspace_id} AND r.vm_id=${principal.vm_id} AND r.state='active' AND a.state='pending' ORDER BY a.created_at LIMIT 20 FOR UPDATE OF a`;
  for (const raw of pending) {
    const row = ResponsibilityRow.extend({ action_id: z.uuid(), action_objective: z.string(), action_context_hash: z.string() }).parse(raw);
    await tx`SELECT id FROM assistant.conversations WHERE id=${row.conversation_id} FOR UPDATE`;
    if (row.trigger.kind !== "daily" && (await snapshot(tx, row)).context_hash !== row.action_context_hash) {
      await tx`UPDATE assistant.responsibility_actions SET state='cancelled' WHERE id=${row.action_id}`;
      continue;
    }
    if ((await tx`SELECT id FROM assistant.tasks WHERE workspace_id=${principal.workspace_id} AND conversation_id=${row.conversation_id} AND state NOT IN ('cancelled','succeeded','failed') LIMIT 1`)[0]) continue;
    const task = z.object({ id: z.uuid() }).parse((await tx`INSERT INTO assistant.tasks(workspace_id,conversation_id,objective,state,origin) VALUES(${principal.workspace_id},${row.conversation_id},${row.action_objective},'queued','responsibility') RETURNING id`)[0]);
    const message=z.object({id:z.uuid()}).parse((await tx`INSERT INTO assistant.messages(workspace_id,conversation_id,task_id,role,content,origin) VALUES(${principal.workspace_id},${row.conversation_id},${task.id},'system',${row.action_objective},'responsibility') RETURNING id`)[0]);
    if(row.skill_id&&row.skill_revision)await bindSkill(tx,{workspace:principal.workspace_id,task:task.id,message:message.id,skill:row.skill_id,revision:row.skill_revision,kind:'scheduled'});
    await tx`UPDATE assistant.responsibility_actions SET state='dispatched',task_id=${task.id},dispatched_at=now() WHERE id=${row.action_id}`;
    await recordEvent(tx, { workspace: principal.workspace_id, kind: "responsibility.dispatched", payload: JSON.stringify({ responsibility_id: row.id, action_id: row.action_id, task_id: task.id }) });
  }
}
