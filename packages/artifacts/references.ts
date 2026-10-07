import { z } from "zod";
import type { Query } from "../../services/control/db";
import { Artifact, DomainError, Id } from "../protocol";
export async function attachmentReferences(
  sql: Query,
  scope: { readonly workspace: string; readonly conversation: string },
  ids: readonly string[],
) {
  const requested = z
    .array(Id)
    .max(8)
    .refine((value) => new Set(value).size === value.length)
    .parse(ids);
  if (requested.length === 0) return [];
  const rows = z
    .array(Artifact)
    .parse(
      await sql`SELECT * FROM assistant.artifacts WHERE workspace_id=${scope.workspace} AND conversation_id=${scope.conversation} AND state='ready' AND id IN ${sql(requested)} FOR UPDATE`,
    );
  if (rows.length !== requested.length)
    throw new DomainError("invalid_attachment", "Attachment unavailable in this conversation", 409);
  return requested.map((id) => {
    const row = rows.find((row) => row.id === id);
    if (!row) throw new DomainError("invalid_attachment", "Attachment unavailable", 409);
    return row;
  });
}
export async function bindAttachments(
  sql: Query,
  scope: { readonly workspace: string; readonly conversation: string; readonly message: string },
  ids: readonly string[],
) {
  for (const [position, id] of ids.entries())
    await sql`INSERT INTO assistant.message_artifacts(workspace_id,conversation_id,message_id,artifact_id,position) VALUES(${scope.workspace},${scope.conversation},${scope.message},${id},${position})`;
}
export async function messageAttachments(sql: Query, workspace: string, message: string) {
  return z
    .array(Artifact)
    .parse(
      await sql`SELECT a.* FROM assistant.message_artifacts ma JOIN assistant.artifacts a ON a.id=ma.artifact_id WHERE ma.workspace_id=${workspace} AND ma.message_id=${message} ORDER BY ma.position`,
    );
}
