import { z } from "zod";
import type { Principal } from "../../services/control/auth";
import type { Database, Query } from "../../services/control/db";
import { conversation } from "../../services/control/repository/common";
import { Artifact, DomainError, Id } from "../protocol";
import { WORKSPACE_ARTIFACT_BYTES } from "./store";
import { fenceRun } from '../../services/control/repository/daemon-session';
export const ArtifactRow = Artifact.extend({
  state: z.enum(["uploading", "ready", "failed", "deleted"]),
  object_key: z.string(),
  workspace_id: Id,
  conversation_id: Id,
  lease_id: Id,
  lease_expires_at: z.string(),
  purged_at: z.string().nullable(),
});
export type ArtifactScope = {
  readonly principal: Principal;
  readonly conversation: string;
  readonly runId?: string;
};
export type UploadMetadata = {
  readonly id: string;
  readonly name: string;
  readonly mediaType: string;
  readonly bytes: number;
  readonly sha256: string;
  readonly series?: string | null;
  readonly changeSummary?: string | null;
};
type Reservation =
  | { readonly kind: "existing"; readonly artifact: z.infer<typeof Artifact> }
  | { readonly kind: "reserved"; readonly leaseId: string; readonly objectKey: string };
export async function authorizeArtifactRun(sql: Query, scope: ArtifactScope, upload = false,lock=true) {
  if (scope.principal.role === "client") return;
  const runId = Id.parse(scope.runId);
  await fenceRun(sql,scope.principal,runId,lock);
  const runs =
    lock?await sql`SELECT r.id FROM assistant.runs r JOIN assistant.tasks t ON t.id=r.task_id WHERE r.workspace_id=${scope.principal.workspace_id} AND r.vm_id=${scope.principal.vm_id} AND r.id=${runId} AND t.conversation_id=${scope.conversation} AND (${upload}::boolean=false OR (r.state IN ('running','waiting') AND t.state IN ('running','waiting'))) FOR UPDATE OF r`
      :await sql`SELECT r.id FROM assistant.runs r JOIN assistant.tasks t ON t.id=r.task_id WHERE r.workspace_id=${scope.principal.workspace_id} AND r.vm_id=${scope.principal.vm_id} AND r.id=${runId} AND t.conversation_id=${scope.conversation}`;
  if (!runs[0]) throw new DomainError("not_found", "Active owned run not found", 404);
}
export async function reserveUpload(
  sql: Database,
  input: { readonly scope: ArtifactScope; readonly metadata: UploadMetadata },
): Promise<Reservation> {
  const workspace = input.scope.principal.workspace_id,
    metadata = input.metadata;
  return sql.begin(async (tx) => {
    await tx`SELECT id FROM assistant.workspaces WHERE id=${workspace} FOR UPDATE`;
    await authorizeArtifactRun(tx, input.scope, true);
    await conversation(tx, workspace, input.scope.conversation);
    const prior =
      await tx`SELECT *,lease_expires_at>now() AS leased FROM assistant.artifacts WHERE id=${metadata.id} FOR UPDATE`;
    let additionalBytes = metadata.bytes;
    if (prior[0]) {
      const row = ArtifactRow.extend({ leased: z.boolean() }).parse(prior[0]);
      if (
        row.workspace_id !== workspace ||
        row.conversation_id !== input.scope.conversation ||
        row.sha256 !== metadata.sha256 ||
        row.bytes !== metadata.bytes ||
        row.name !== metadata.name ||
        row.media_type !== metadata.mediaType ||
        (row.series_key ?? null) !== (metadata.series ?? null) ||
        (row.change_summary ?? null) !== (metadata.changeSummary ?? null)
      )
        throw new DomainError(
          "idempotency_conflict",
          "Artifact ID already used with different data",
          409,
        );
      if (row.state === "ready") return { kind: "existing", artifact: Artifact.parse(row) };
      if (row.state === "deleted")
        throw new DomainError("artifact_deleted", "Deleted artifact ID cannot be reused", 409);
      if (row.state === "uploading" && row.leased)
        throw new DomainError("artifact_uploading", "Upload already in progress; retry later", 409);
      if (row.purged_at === null) additionalBytes = 0;
    }
    const total = z
      .object({ bytes: z.coerce.number() })
      .parse(
        (
          await tx`SELECT COALESCE(sum(bytes),0) AS bytes FROM assistant.artifacts WHERE workspace_id=${workspace} AND purged_at IS NULL`
        )[0],
      ).bytes;
    if (total + additionalBytes > WORKSPACE_ARTIFACT_BYTES)
      throw new DomainError("artifact_quota_exceeded", "Workspace file quota is 1 GB", 409);
    const objectKey = `${workspace}/${metadata.id}`,
      leaseId = crypto.randomUUID();
    await tx`INSERT INTO assistant.artifacts(id,workspace_id,conversation_id,name,media_type,bytes,sha256,object_key,lease_id,lease_expires_at,series_key,change_summary) VALUES(${metadata.id},${workspace},${input.scope.conversation},${metadata.name},${metadata.mediaType},${metadata.bytes},${metadata.sha256},${objectKey},${leaseId},now()+interval '15 minutes',${metadata.series ?? null},${metadata.changeSummary ?? null}) ON CONFLICT(id) DO UPDATE SET state='uploading',lease_id=${leaseId},lease_expires_at=now()+interval '15 minutes',purged_at=NULL`;
    return { kind: "reserved", objectKey, leaseId };
  });
}
