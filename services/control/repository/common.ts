import { z } from "zod";
import {
  attachmentReferences,
  bindAttachments,
  messageAttachments,
} from "../../../packages/artifacts/references";
import { DomainError, Message, Task } from "../../../packages/protocol";
import type { Query } from "../db";
import { legacyAttentionTexts } from "../../../packages/notifications/attention-text.ts";
import { replyPreview, replySource } from '../../../packages/context/store-reply';
import { lockWorkspace } from './lock-order';
export async function conversation(sql: Query, workspace: string, id: string) {
  await lockWorkspace(sql,workspace);
  const rows =
    await sql`SELECT id FROM assistant.conversations WHERE workspace_id=${workspace} AND id=${id} FOR UPDATE`;
  if (!rows[0]) throw new DomainError("not_found", "Conversation not found", 404);
}
export async function appendMessage(
  sql: Query,
  input: {
    readonly workspace: string;
    readonly conversation: string;
    readonly content: string;
    readonly clientId: string;
    readonly attachments?: readonly string[];
    readonly role?: "user" | "system";
    readonly origin?: "user" | "schedule" | "responsibility";
    readonly returnControl?: true;
    readonly replyTo?: string;
  },
) {
  await lockWorkspace(sql,input.workspace);
  if(input.origin && input.origin !== 'user')return createBackgroundTask(sql,{workspace:input.workspace,conversation:input.conversation,objective:input.content,origin:input.origin,clientId:input.clientId});
  if (input.returnControl)
    await sql`SELECT id FROM assistant.vms WHERE workspace_id=${input.workspace} ORDER BY id FOR NO KEY UPDATE`;
  await conversation(sql, input.workspace, input.conversation);
  const prior =
    await sql`SELECT * FROM assistant.messages WHERE conversation_id=${input.conversation} AND client_message_id=${input.clientId}`;
  if (prior[0]) {
    const priorMessage = Message.parse(prior[0]);
    const attachments = await messageAttachments(sql, input.workspace, priorMessage.id);
    const message = { ...priorMessage, attachments };
    if (
      message.content !== input.content ||
      message.role !== (input.role ?? "user") ||
      (message.reply_to_message_id ?? null) !== (input.replyTo ?? null) ||
      JSON.stringify(attachments.map((file) => file.id)) !== JSON.stringify(input.attachments ?? [])
    )
      throw new DomainError(
        "idempotency_conflict",
        "Message ID already used with different content",
        409,
      );
    const link = z.object({ task_id: z.uuid() }).parse(prior[0]);
    const tasks = await sql`SELECT * FROM assistant.tasks WHERE id=${link.task_id}`;
    return { message: {...message,reply:input.replyTo?await replyPreview(sql,input.workspace,input.replyTo):null}, task: Task.parse(tasks[0]) };
  }
  if(input.replyTo)await replySource(sql,input.workspace,input.replyTo);
  const attachments = await attachmentReferences(
    sql,
    { workspace: input.workspace, conversation: input.conversation },
    input.attachments ?? [],
  );
  const active =
    await sql`SELECT * FROM assistant.tasks WHERE conversation_id=${input.conversation} AND lane='foreground' AND state NOT IN ('cancelled','succeeded','failed') AND (${!input.replyTo} OR state<>'unknown') ORDER BY (state='unknown'),created_at DESC LIMIT 1 FOR UPDATE`;
  const task = Task.parse(
    active[0] ??
      (
        await sql`INSERT INTO assistant.tasks(workspace_id,conversation_id,objective,origin) VALUES(${input.workspace},${input.conversation},${input.content || attachments.map((file) => file.name).join(", ")},${input.origin ?? "user"}) RETURNING *`
      )[0],
  );
  const rows =
    await sql`INSERT INTO assistant.messages(workspace_id,conversation_id,task_id,role,content,client_message_id,reply_to_message_id,origin) VALUES(${input.workspace},${input.conversation},${task.id},${input.role ?? "user"},${input.content},${input.clientId},${input.replyTo??null},${input.origin ?? "user"}) RETURNING *`;
  const message = { ...Message.parse(rows[0]), attachments,reply:input.replyTo?await replyPreview(sql,input.workspace,input.replyTo):null };
  await bindAttachments(
    sql,
    { workspace: input.workspace, conversation: input.conversation, message: message.id },
    attachments.map((file) => file.id),
  );
  await recordEvent(sql, {
    workspace: input.workspace,
    kind: "message.created",
    payload: JSON.stringify({ message, task }),
  });
  return { message, task };
}
export async function recordEvent(
  sql: Query,
  event: { readonly workspace: string; readonly kind: string; readonly payload: string },
) {
  await sql`WITH e AS (INSERT INTO assistant.events(workspace_id,kind,payload) VALUES(${event.workspace},${event.kind},${event.payload}::text::jsonb) RETURNING id) INSERT INTO assistant.outbox(workspace_id,event_id) SELECT ${event.workspace},id FROM e`;
}
export async function createBackgroundTask(sql: Query, input: {
  readonly workspace: string; readonly conversation: string; readonly objective: string;
  readonly title?: string | null;
  readonly origin: 'schedule' | 'responsibility'; readonly clientId: string;
}) {
  await conversation(sql,input.workspace,input.conversation);
  const prior=(await sql`SELECT * FROM assistant.messages WHERE conversation_id=${input.conversation} AND client_message_id=${input.clientId}`)[0];
  if(prior){
    const message=Message.parse(prior);
    if(message.content!==input.objective||message.origin!==input.origin||message.role!=='system'||!message.hidden)
      throw new DomainError('idempotency_conflict','Background wake ID reused',409);
    const task=Task.parse((await sql`SELECT * FROM assistant.tasks WHERE id=${message.task_id??null} AND lane='background'`)[0]);
    return {message,task};
  }
  const task=Task.parse((await sql`INSERT INTO assistant.tasks(workspace_id,conversation_id,objective,title,origin,lane) VALUES(${input.workspace},${input.conversation},${input.objective},${input.title?.trim().slice(0,60) || null},${input.origin},'background') RETURNING *`)[0]);
  const message=Message.parse((await sql`INSERT INTO assistant.messages(workspace_id,conversation_id,task_id,role,content,client_message_id,origin,hidden) VALUES(${input.workspace},${input.conversation},${task.id},'system',${input.objective},${input.clientId},${input.origin},true) RETURNING *`)[0]);
  await recordEvent(sql,{workspace:input.workspace,kind:'message.created',payload:JSON.stringify({message,task})});
  return {message,task};
}
export async function messages(sql: Query, workspace: string, id: string, after = 0) {
  const rows = await sql`SELECT m.*,
    (SELECT jsonb_build_object('task_id',r.task_id,'run_id',r.id,'state',n.state,'reason',
      CASE WHEN m.role='system' AND m.content IN ${sql([...legacyAttentionTexts])}
        THEN COALESCE(NULLIF(btrim(t.reason),''),'오류 상세 정보가 없습니다.') ELSE m.content END)
      FROM assistant.notification_attention_messages n JOIN assistant.runs r ON r.id=n.run_id
      JOIN assistant.tasks t ON t.id=r.task_id AND t.workspace_id=r.workspace_id
      WHERE n.message_id=m.id AND r.workspace_id=m.workspace_id AND t.conversation_id=m.conversation_id
      ORDER BY r.created_at DESC,n.state DESC LIMIT 1) AS task_status,
    (SELECT min(i.applied_at) FROM assistant.input_receipts i WHERE i.workspace_id=m.workspace_id AND i.message_id=m.id AND m.role='user') AS read_at,
    COALESCE((SELECT jsonb_agg(to_jsonb(a) ORDER BY ma.position) FROM assistant.message_artifacts ma JOIN assistant.artifacts a ON a.id=ma.artifact_id WHERE ma.message_id=m.id),'[]'::jsonb) AS attachments,
    (SELECT jsonb_object_agg(c.block_id,jsonb_build_object('state',c.state,'option',c.option,'snoozed_until',c.snoozed_until,'approved_body',c.approved_body,'retry_ok',c.retry_ok)) FROM assistant.card_states c WHERE c.workspace_id=m.workspace_id AND c.message_id=m.id) AS card_states
    FROM assistant.messages m WHERE m.workspace_id=${workspace} AND m.conversation_id=${id} AND NOT m.hidden AND m.sequence>${after} ORDER BY m.sequence`;
  const parsed=z.array(Message).parse(rows.map(row=>{
    const value={...row};
    if(value['task_status']===null)delete value['task_status'];
    if(value['card_states']===null)delete value['card_states'];
    return value;
  }));
  const previews=new Map(await Promise.all([...new Set(parsed.flatMap(message=>message.reply_to_message_id?[message.reply_to_message_id]:[]))].map(async id=>[id,await replyPreview(sql,workspace,id)] as const)));
  return parsed.map(message=>({...message,reply:message.reply_to_message_id?previews.get(message.reply_to_message_id)??null:null}));
}
