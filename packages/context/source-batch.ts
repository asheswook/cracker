import { z } from "zod";
import { hashToken } from "../../services/control/auth";
import type { Query } from "../../services/control/db";
import { DomainError } from "../protocol";
import { RetentionDecision } from "../memory/retention";
import { SemanticLink, SemanticSource } from "./schema";
import { RawSource, type ContextScope } from "./store-source";

const BatchRow = RawSource.extend({ conversation_id: z.uuid(), link: SemanticLink.extend({ conversation_id: z.uuid() }).nullable() });
const RetentionRow = z.object({
  message_id: z.uuid(), suppressed: z.boolean(), pending: z.boolean(),
  current: z.object({ action: RetentionDecision.shape.action.nullable(), suppressed: z.boolean() }).nullable(),
  persistent: RetentionDecision.shape.action.nullable(),
});
export type BatchedSource = Readonly<{
  raw: z.infer<typeof RawSource>;
  conversation: string;
  link: z.infer<typeof SemanticLink> | null;
  sha256: string;
  retentionAllowed: boolean;
}>;
const batchSize = 128;

export function requireSource(records: ReadonlyMap<string, BatchedSource>, id: string): BatchedSource {
  const record = records.get(id);
  if (!record) throw new DomainError("invalid_source", "Source is outside this workspace", 409);
  return record;
}

export function batchSourceView(record: BatchedSource, limit = 1800) {
  const source = record.raw;
  return SemanticSource.parse({ ...source, conversation_id: record.conversation, content: source.content.slice(0, limit), truncated: source.content.length > limit, sha256: record.sha256, retention_allowed: record.retentionAllowed, linked_context_id: record.link?.context_id ?? null });
}

export async function sourceBatch(sql: Query, scope: ContextScope, ids: readonly string[]): Promise<ReadonlyMap<string, BatchedSource>> {
  const requested = [...new Set(ids)];
  const result = new Map<string, BatchedSource>();
  for (let offset = 0; offset < requested.length; offset += batchSize) {
    const chunk = requested.slice(offset, offset + batchSize);
    const rows = z.array(BatchRow).parse(await sql`WITH requested AS (
      SELECT m.* FROM assistant.messages m WHERE m.workspace_id=${scope.workspace} AND m.id=ANY(${sql.array(chunk)}::uuid[])
    ), selected AS (
      SELECT id FROM requested UNION
      SELECT origin.id FROM requested m
      JOIN assistant.semantic_context_links l ON l.workspace_id=m.workspace_id AND l.conversation_id=m.conversation_id AND l.message_id=m.id
      JOIN assistant.messages origin ON origin.workspace_id=m.workspace_id AND origin.conversation_id=m.conversation_id AND origin.id=l.originating_message_id
      WHERE m.role='assistant' AND NOT EXISTS(SELECT 1 FROM assistant.memory_suppressions x WHERE x.workspace_id=m.workspace_id AND x.source_message_id=m.id)
    ) SELECT m.id AS message_id,m.task_id,m.sequence,m.role,m.content,m.created_at,m.conversation_id,
      COALESCE((SELECT jsonb_agg(jsonb_build_object('id',a.id,'name',a.name,'media_type',a.media_type,'bytes',a.bytes,'sha256',a.sha256) ORDER BY ma.position) FROM assistant.message_artifacts ma JOIN assistant.artifacts a ON a.id=ma.artifact_id AND a.workspace_id=ma.workspace_id WHERE ma.message_id=m.id AND a.state='ready'),'[]'::jsonb) AS attachments,
      CASE WHEN l.message_id IS NULL THEN NULL ELSE to_jsonb(l) END AS link
      FROM assistant.messages m JOIN selected ON selected.id=m.id
      LEFT JOIN assistant.semantic_context_links l ON l.workspace_id=m.workspace_id AND l.message_id=m.id
      WHERE m.workspace_id=${scope.workspace}`);
    const byId = new Map(rows.map(row => [row.message_id, row]));
    const retention = new Map(z.array(RetentionRow).parse(await sql`SELECT m.id AS message_id,
      EXISTS(SELECT 1 FROM assistant.memory_suppressions x WHERE x.workspace_id=m.workspace_id AND x.source_message_id=m.id) AS suppressed,
      EXISTS(SELECT 1 FROM assistant.messages u LEFT JOIN assistant.memory_retention_decisions d ON d.workspace_id=u.workspace_id AND d.source_message_id=u.id LEFT JOIN assistant.semantic_source_retention s ON s.workspace_id=u.workspace_id AND s.source_message_id=u.id WHERE u.workspace_id=m.workspace_id AND u.conversation_id=m.conversation_id AND u.task_id IS NOT DISTINCT FROM m.task_id AND u.role='user' AND u.sequence<=m.sequence AND d.source_message_id IS NULL AND s.source_message_id IS NULL) AS pending,
      (SELECT jsonb_build_object('action',COALESCE(d.action,s.action),'suppressed',EXISTS(SELECT 1 FROM assistant.memory_suppressions x WHERE x.workspace_id=u.workspace_id AND x.source_message_id=u.id)) FROM assistant.messages u LEFT JOIN assistant.memory_retention_decisions d ON d.workspace_id=u.workspace_id AND d.source_message_id=u.id LEFT JOIN assistant.semantic_source_retention s ON s.workspace_id=u.workspace_id AND s.source_message_id=u.id WHERE u.workspace_id=m.workspace_id AND u.conversation_id=m.conversation_id AND u.task_id IS NOT DISTINCT FROM m.task_id AND u.role='user' AND u.sequence<=m.sequence ORDER BY u.sequence DESC LIMIT 1) AS current,
      (SELECT COALESCE(d.action,s.action) FROM assistant.messages u LEFT JOIN assistant.memory_retention_decisions d ON d.workspace_id=u.workspace_id AND d.source_message_id=u.id LEFT JOIN assistant.semantic_source_retention s ON s.workspace_id=u.workspace_id AND s.source_message_id=u.id WHERE u.workspace_id=m.workspace_id AND u.conversation_id=m.conversation_id AND u.task_id IS NOT DISTINCT FROM m.task_id AND u.sequence<=m.sequence AND COALESCE(d.action,s.action) IN ('allow','deny_task') ORDER BY u.sequence DESC LIMIT 1) AS persistent
      FROM assistant.messages m WHERE m.workspace_id=${scope.workspace} AND m.id=ANY(${sql.array(rows.map(row => row.message_id))}::uuid[])`).map(row => [row.message_id, row]));
    function allowed(row: z.infer<typeof BatchRow>): boolean {
      const decision = retention.get(row.message_id);
      if (!decision) throw new DomainError("invalid_source", "Source is outside this workspace", 409);
      if (decision.suppressed) return false;
      if (row.role === "assistant" && row.link?.conversation_id === row.conversation_id && row.link.originating_message_id) {
        const origin = byId.get(row.link.originating_message_id);
        if (!origin) throw new DomainError("invalid_source", "Message is outside the run conversation", 409);
        if (origin.role !== "user" || origin.task_id !== row.task_id || origin.sequence >= row.sequence) return false;
        return allowed(origin);
      }
      if (decision.pending) return false;
      if (!decision.current) return true;
      const action = RetentionDecision.shape.action.parse(decision.current.action);
      if (decision.current.suppressed || action === "deny_turn" || action === "deny_task") return false;
      if (action === "allow") return true;
      return decision.persistent === null || decision.persistent === "allow";
    }
    for (const id of chunk) {
      const row = byId.get(id);
      if (!row) continue;
      const raw = RawSource.parse(row);
      result.set(id, { raw, conversation: row.conversation_id, link: row.link, sha256: await hashToken(JSON.stringify(raw)), get retentionAllowed() { return allowed(row); } });
    }
  }
  return result;
}
