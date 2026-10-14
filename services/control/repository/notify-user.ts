import { z } from "zod";
import { DomainError, Id, Message } from "../../../packages/protocol";
import { enqueueMessageNotification } from "../../../packages/notifications/store.ts";
import type { Principal } from "../auth";
import type { Query } from "../db";
import { conversation, recordEvent } from "./common";
import { loadRun } from "./runs";

export const NotifyUserRequest = z.object({ run_id: Id, conversation_id: Id, client_message_id: Id, message: z.string().trim().min(1).max(2000) });
export async function notifyUser(sql: Query, principal: Principal, request: z.infer<typeof NotifyUserRequest>) {
  if (principal.role !== "vm") throw new DomainError("forbidden", "VM credential required", 403);
  const run = await loadRun(sql, principal, request.run_id,'key-share');
  const task = z.object({ conversation_id: Id, state: z.string(), origin: z.enum(["user", "schedule", "responsibility"]) }).parse(
    (await sql`SELECT conversation_id,state,origin FROM assistant.tasks WHERE id=${run.task_id} AND workspace_id=${principal.workspace_id}`)[0],
  );
  if (task.conversation_id !== request.conversation_id) throw new DomainError("not_found", "Run conversation not found", 404);
  if (!["running", "waiting"].includes(run.state) || !["running", "waiting"].includes(task.state)) throw new DomainError("stale_run", "Active owned run required", 409);
  await conversation(sql, principal.workspace_id, task.conversation_id);
  const prior = (await sql`SELECT * FROM assistant.messages WHERE conversation_id=${task.conversation_id} AND client_message_id=${request.client_message_id}`)[0];
  if (prior) {
    const message = Message.parse(prior);
    if (message.task_id !== run.task_id || message.role !== "assistant" || message.content !== request.message || !message.notify)
      throw new DomainError("idempotency_conflict", "Notification key reused", 409);
    return { message };
  }
  const message = Message.parse((await sql`INSERT INTO assistant.messages(workspace_id,conversation_id,task_id,role,content,client_message_id,origin,notify) VALUES(${principal.workspace_id},${task.conversation_id},${run.task_id},'assistant',${request.message},${request.client_message_id},${task.origin},true) RETURNING *`)[0]);
  await enqueueMessageNotification(sql, principal.workspace_id, { id: message.id, runId: run.id });
  await recordEvent(sql, { workspace: principal.workspace_id, kind: "message.created", payload: JSON.stringify({ message }) });
  return { message };
}
