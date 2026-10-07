import { z } from "zod";
import type { Principal } from "../../services/control/auth";
import type { Query } from "../../services/control/db";
import { DomainError } from "../protocol";
import { SourceFile } from "./schema";
export const Scope = z.object({ task_id: z.uuid(), conversation_id: z.uuid() });
export type ContextScope = Readonly<{ workspace: string; conversation: string }>;
export const RawSource = z.object({ message_id: z.uuid(), task_id: z.uuid().nullable(), sequence: z.coerce.number().int(), role: z.enum(["user","assistant","system"]), content: z.string(), created_at:z.iso.datetime(), attachments: z.array(SourceFile).max(8) });
export async function ownedScope(sql: Query, principal: Principal, run: string, lock = false, mode: "live" | "backfill" = "live") {
  if (principal.role !== "vm" || !principal.vm_id) throw new DomainError("forbidden", "VM credentials required", 403);
  let locked: z.infer<typeof Scope> | undefined;
  if (lock) {
    // Receipts acquire a workspace FK lock; take it before the conversation, as memory extraction does.
    await sql`SELECT id FROM assistant.workspaces WHERE id=${principal.workspace_id} FOR KEY SHARE`;
    // Match VM → run → conversation → task order; receipts also acquire a VM FK lock.
    await sql`SELECT id FROM assistant.vms WHERE id=${principal.vm_id} AND workspace_id=${principal.workspace_id} FOR SHARE`;
    const owners = await sql`SELECT r.task_id,t.conversation_id FROM assistant.runs r JOIN assistant.tasks t ON t.id=r.task_id AND t.workspace_id=r.workspace_id WHERE r.id=${run} AND r.workspace_id=${principal.workspace_id} AND r.vm_id=${principal.vm_id} FOR SHARE OF r`;
    if (!owners[0]) throw new DomainError("stale_run", "Owned active run required", 409);
    locked = Scope.parse(owners[0]);
    await sql`SELECT id FROM assistant.conversations WHERE workspace_id=${principal.workspace_id} AND id=${locked.conversation_id} FOR UPDATE`;
  }
  const rows = await sql`SELECT r.task_id,t.conversation_id FROM assistant.runs r JOIN assistant.tasks t ON t.id=r.task_id AND t.workspace_id=r.workspace_id WHERE r.id=${run} AND r.workspace_id=${principal.workspace_id} AND r.vm_id=${principal.vm_id} AND (${mode==='backfill'} OR (r.state IN ('running','waiting') AND t.state IN ('running','waiting'))) ${lock ? sql`FOR SHARE OF t` : sql``}`;
  if (!rows[0]) throw new DomainError("stale_run", "Owned active run required", 409);
  const scope = Scope.parse(rows[0]);
  if (locked && (scope.task_id !== locked.task_id || scope.conversation_id !== locked.conversation_id)) throw new DomainError("stale_run", "Run scope changed while locking", 409);
  return scope;
}
export async function rawSource(sql: Query, scope: ContextScope, id: string) {
  const rows = await sql`SELECT m.id AS message_id,m.task_id,m.sequence,m.role,m.content,m.created_at,COALESCE((SELECT jsonb_agg(jsonb_build_object('id',a.id,'name',a.name,'media_type',a.media_type,'bytes',a.bytes,'sha256',a.sha256) ORDER BY ma.position) FROM assistant.message_artifacts ma JOIN assistant.artifacts a ON a.id=ma.artifact_id AND a.workspace_id=ma.workspace_id WHERE ma.message_id=m.id AND a.state='ready'),'[]'::jsonb) AS attachments FROM assistant.messages m WHERE m.id=${id} AND m.workspace_id=${scope.workspace} AND m.conversation_id=${scope.conversation}`;
  if (!rows[0]) throw new DomainError("invalid_source", "Message is outside the run conversation", 409);
  return RawSource.parse(rows[0]);
}

export async function sourceScope(sql: Query, workspace: string, message: string): Promise<ContextScope> {
  const row=(await sql`SELECT conversation_id FROM assistant.messages WHERE workspace_id=${workspace} AND id=${message}`)[0];
  if(!row)throw new DomainError("invalid_source","Source is outside this workspace",409);
  return {workspace,conversation:z.object({conversation_id:z.uuid()}).parse(row).conversation_id};
}
export async function referenceSource(sql: Query, scope: ContextScope, message: string) {
  return rawSource(sql,await sourceScope(sql,scope.workspace,message),message);
}
export async function lockContexts(sql: Query, workspace: string, ids: readonly string[]) {
  const requested=[...new Set(ids)].sort();
  const rows=await sql`SELECT id FROM assistant.semantic_contexts WHERE workspace_id=${workspace} AND id=ANY(${sql.array(requested)}::uuid[]) ORDER BY id FOR UPDATE`;
  if(rows.length!==requested.length)throw new DomainError("invalid_context","Context is outside this workspace",409);
}
