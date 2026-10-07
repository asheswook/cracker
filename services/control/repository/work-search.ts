import { z } from "zod";
import { DomainError, Message } from "../../../packages/protocol/index.ts";
import { PriorSourcePage, WorkSearchPage, type WorkSearchRequest } from "../../../packages/protocol/work-search.ts";
import type { Principal } from "../auth.ts";
import type { Query } from "../db.ts";

export async function authorizeReferenceRun(sql: Query, principal: Principal, run: string): Promise<void> {
  const rows = await sql`SELECT r.id FROM assistant.runs r JOIN assistant.tasks t ON t.id=r.task_id AND t.workspace_id=r.workspace_id WHERE r.id=${run} AND r.workspace_id=${principal.workspace_id} AND r.vm_id=${principal.vm_id} AND r.state IN ('running','waiting') AND t.state IN ('running','waiting')`;
  if (!rows[0]) throw new DomainError("not_found", "Active owned run not found", 404);
}

export async function readPriorSource(sql: Query, principal: Principal, messageId: string) {
  const rows = await sql`SELECT m.*,COALESCE((SELECT jsonb_agg(to_jsonb(a) ORDER BY ma.position) FROM assistant.message_artifacts ma JOIN assistant.artifacts a ON a.id=ma.artifact_id AND a.workspace_id=m.workspace_id WHERE ma.message_id=m.id AND a.state IN ('ready','deleted')),'[]'::jsonb) AS attachments FROM assistant.messages m WHERE m.id=${messageId} AND m.workspace_id=${principal.workspace_id}`;
  if (!rows[0]) throw new DomainError("not_found", "Source message not found", 404);
  const message = Message.parse(rows[0]);
  return PriorSourcePage.parse({ message, conversation_id: message.conversation_id });
}

export async function searchWork(sql: Query, workspace: string, request: z.infer<typeof WorkSearchRequest>) {
  const cursor = request.cursor;
  const rows = await sql`
    WITH candidates AS (
      SELECT 'message'::text AS kind,m.id,m.created_at,m.conversation_id,c.title AS conversation_title,m.id AS source_message_id,m.role AS source_role,
        concat_ws(E'\n',m.content,CASE WHEN m.sequence=(SELECT min(first.sequence) FROM assistant.messages first WHERE first.task_id=m.task_id AND first.workspace_id=m.workspace_id) THEN concat_ws(E'\n',t.objective,t.reason) END) AS body,to_jsonb(t) AS task,NULL::jsonb AS artifact,false AS file_text_truncated
      FROM assistant.messages m JOIN assistant.conversations c ON c.id=m.conversation_id AND c.workspace_id=m.workspace_id
      LEFT JOIN assistant.tasks t ON t.id=m.task_id AND t.workspace_id=m.workspace_id
      WHERE m.workspace_id=${workspace}
      UNION ALL
      SELECT 'artifact',a.id,a.created_at,a.conversation_id,c.title,m.id,m.role,concat_ws(E'\n',a.name,a.search_text),to_jsonb(t),to_jsonb(a)-'object_key'-'search_text'-'workspace_id'-'lease_id',a.search_text_truncated
      FROM assistant.artifacts a JOIN assistant.conversations c ON c.id=a.conversation_id AND c.workspace_id=a.workspace_id
      JOIN LATERAL (SELECT original.* FROM assistant.message_artifacts ma JOIN assistant.messages original ON original.id=ma.message_id AND original.workspace_id=a.workspace_id WHERE ma.artifact_id=a.id ORDER BY original.sequence LIMIT 1) m ON true
      LEFT JOIN assistant.tasks t ON t.id=m.task_id AND t.workspace_id=a.workspace_id
      WHERE a.workspace_id=${workspace} AND a.state='ready'
    ) SELECT kind,id,to_char(created_at AT TIME ZONE 'UTC','YYYY-MM-DD"T"HH24:MI:SS.US"Z"') AS created_at,conversation_id,left(conversation_title,240) AS conversation_title,source_message_id,source_role,
      substring(body FROM greatest(1,strpos(lower(body),lower(${request.query}))-100) FOR 500) AS snippet,
      CASE WHEN task IS NULL THEN NULL ELSE jsonb_set(jsonb_set(task,'{objective}',to_jsonb(left(task->>'objective',1200))),'{reason}',COALESCE(to_jsonb(left(task->>'reason',1200)),'null'::jsonb)) END AS task,artifact,file_text_truncated
    FROM candidates WHERE strpos(lower(body),lower(${request.query}))>0
      AND (${request.conversation_id}::uuid IS NULL OR conversation_id=${request.conversation_id}::uuid)
      AND (${request.state}='all' OR (${request.state}='active' AND task->>'state' NOT IN ('cancelled','succeeded','failed')) OR (${request.state}='finished' AND task->>'state' IN ('cancelled','succeeded','failed')))
      AND (${cursor?.id ?? null}::uuid IS NULL OR (created_at,id,kind)<(${cursor?.created_at ?? null}::text::timestamptz,${cursor?.id ?? null}::uuid,${cursor?.kind ?? null}::text))
    ORDER BY created_at DESC,id DESC,kind DESC LIMIT ${request.limit + 1}`;
  const page = rows.slice(0, request.limit), last = page.at(-1);
  return WorkSearchPage.parse({ hits:page, next_cursor:rows.length > request.limit && last ? {created_at:last["created_at"],id:last["id"],kind:last["kind"]}:null, unindexed_text_files:0 });
}
