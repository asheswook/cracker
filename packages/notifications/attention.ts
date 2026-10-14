import { z } from "zod";
import type { Query } from "../../services/control/db.ts";
import { recordEvent } from "../../services/control/repository/common.ts";
import { enqueueMessageNotification } from "./store.ts";
import { legacyAttentionTexts } from "./attention-text.ts";

export async function preserveAttentionReason(sql: Query, workspace: string, runId: string): Promise<void> {
  const rows = z.array(z.object({ id:z.uuid(), conversation_id:z.uuid() })).parse(await sql`
    UPDATE assistant.messages m SET content=t.reason
    FROM assistant.notification_attention_messages a,assistant.runs r,assistant.tasks t
    WHERE a.message_id=m.id AND a.run_id=r.id AND r.task_id=t.id
      AND r.id=${runId} AND r.workspace_id=${workspace} AND t.workspace_id=${workspace}
      AND m.workspace_id=${workspace} AND m.conversation_id=t.conversation_id
      AND m.role='system' AND m.content IN ${sql([...legacyAttentionTexts])}
      AND NULLIF(btrim(t.reason),'') IS NOT NULL
    RETURNING m.id,m.conversation_id`);
  for(const row of rows)await recordEvent(sql,{workspace,kind:"message.status",payload:JSON.stringify({message_id:row.id,conversation_id:row.conversation_id})});
}

export async function publishAttentionMessage(
  sql: Query,
  workspace: string,
  run: { readonly id: string; readonly state: "failed" | "unknown" },
): Promise<void> {
  const link = z
    .object({ task_id: z.uuid(), conversation_id: z.uuid(), created_at: z.string(), reason: z.string().nullable() })
    .parse(
      (
        await sql`SELECT r.task_id,r.created_at,t.conversation_id,t.reason FROM assistant.runs r JOIN assistant.tasks t ON t.id=r.task_id AND t.workspace_id=r.workspace_id WHERE r.id=${run.id} AND r.workspace_id=${workspace} FOR UPDATE OF r`
      )[0],
    );
  const content = link.reason?.trim() || (run.state === "failed" ? "작업 오류: 상세 정보가 없습니다." : "실행 오류: 상세 정보가 없습니다.");
  if (
    (
      await sql`SELECT message_id FROM assistant.notification_attention_messages WHERE run_id=${run.id} AND state=${run.state}`
    )[0]
  )
    return;
  const equivalent = z
    .object({ id: z.uuid() })
    .optional()
    .parse(
      (
        await sql`SELECT id FROM assistant.messages WHERE workspace_id=${workspace} AND task_id=${link.task_id} AND role='assistant' AND content=${content} AND created_at>=${link.created_at} ORDER BY sequence DESC LIMIT 1`
      )[0],
    );
  // Taskless status is visible history, never a new system input awaiting a run receipt.
  const message =
    equivalent ??
    z.object({ id: z.uuid() }).parse(
      (
        await sql`INSERT INTO assistant.messages(workspace_id,conversation_id,role,content)
      VALUES(${workspace},${link.conversation_id},'system',${content}) RETURNING id`
      )[0],
    );
  await sql`INSERT INTO assistant.notification_attention_messages(run_id,state,message_id) VALUES(${run.id},${run.state},${message.id})`;
  await sql`UPDATE assistant.messages SET notify=true WHERE id=${message.id} AND workspace_id=${workspace}`;
  await enqueueMessageNotification(sql, workspace, { id: message.id, runId: run.id });
  if (!equivalent)
    await recordEvent(sql, {
      workspace,
      kind: "message.status",
      payload: JSON.stringify({ message_id: message.id, conversation_id: link.conversation_id }),
    });
}
