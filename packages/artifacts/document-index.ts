import { z } from "zod";
import type { Principal } from "../../services/control/auth.ts";
import type { Database, Query } from "../../services/control/db.ts";
import { DomainError } from "../protocol/index.ts";
import {
  DocumentLease,
  type DocumentLeaseIdentity,
  type DocumentResult,
  documentFormat,
} from "./document-types.ts";

export async function documentIdle(sql: Query, principal: Principal): Promise<boolean> {
  const rows =
    await sql`SELECT id FROM assistant.vms v WHERE id=${principal.vm_id} AND workspace_id=${principal.workspace_id}
    AND control_state='agent' AND last_seen_at>now()-interval '30 seconds'
    AND NOT EXISTS(SELECT 1 FROM assistant.runs r WHERE r.vm_id=v.id AND r.state NOT IN ('cancelled','succeeded','failed'))
    AND NOT EXISTS(SELECT 1 FROM assistant.tasks t WHERE t.workspace_id=v.workspace_id AND t.state='queued')
    AND NOT EXISTS(SELECT 1 FROM assistant.commands c WHERE c.vm_id=v.id AND c.status='pending')`;
  return rows.length > 0;
}

export async function retryDocument(
  sql: Query,
  artifact: string,
  code: string,
  yielded = false,
): Promise<void> {
  await sql`UPDATE assistant.artifact_search_jobs SET failures=LEAST(3,failures+${yielded ? 0 : 1}),
    status=CASE WHEN failures+${yielded ? 0 : 1}>=3 THEN 'failed' ELSE 'pending' END,
    outcome=${code}, lease_id=NULL,vm_id=NULL,lease_expires_at=NULL,updated_at=now(),
    next_attempt_at=now()+CASE WHEN ${yielded} THEN interval '5 seconds' WHEN failures=0 THEN interval '30 seconds' ELSE interval '5 minutes' END
    WHERE artifact_id=${artifact} AND extractor_version=1`;
  await sql`UPDATE assistant.artifacts a SET search_indexed=true WHERE a.id=${artifact} AND a.state='ready'
    AND EXISTS(SELECT 1 FROM assistant.artifact_search_jobs j WHERE j.artifact_id=a.id AND j.extractor_version=1 AND j.status='failed')`;
}

export async function claimDocument(sql: Database, principal: Principal) {
  return sql.begin(async (tx) => {
    if (!principal.vm_id) throw new DomainError("forbidden", "VM required", 403);
    await tx`SELECT pg_advisory_xact_lock(hashtextextended(${principal.vm_id},619083024))`;
    const expired =
      await tx`SELECT artifact_id FROM assistant.artifact_search_jobs WHERE workspace_id=${principal.workspace_id}
      AND status='leased' AND lease_expires_at<=now() ORDER BY lease_expires_at LIMIT 8 FOR UPDATE SKIP LOCKED`;
    for (const raw of expired)
      await retryDocument(
        tx,
        z.object({ artifact_id: z.uuid() }).parse(raw).artifact_id,
        "lease_expired",
      );
    if (!(await documentIdle(tx, principal))) return null;
    if (
      (
        await tx`SELECT artifact_id FROM assistant.artifact_search_jobs WHERE vm_id=${principal.vm_id} AND status='leased'`
      )[0]
    )
      return null;
    await tx`INSERT INTO assistant.artifact_search_jobs(artifact_id,workspace_id,extractor_version)
      SELECT a.id,a.workspace_id,1 FROM assistant.artifacts a WHERE a.workspace_id=${principal.workspace_id} AND a.state='ready' AND a.search_indexed=false
      AND (a.media_type IN ('application/pdf','application/vnd.openxmlformats-officedocument.wordprocessingml.document') OR (a.media_type='application/octet-stream' AND (lower(a.name) LIKE '%.pdf' OR lower(a.name) LIKE '%.docx')))
      AND a.bytes BETWEEN 0 AND 10485760 AND EXISTS(SELECT 1 FROM assistant.message_artifacts ma WHERE ma.artifact_id=a.id AND ma.workspace_id=a.workspace_id)
      AND NOT EXISTS(SELECT 1 FROM assistant.artifact_search_jobs j WHERE j.artifact_id=a.id AND j.extractor_version=1)
      ORDER BY a.created_at,a.id LIMIT 8 ON CONFLICT DO NOTHING`;
    const rows =
      await tx`SELECT j.artifact_id,a.media_type,a.name,a.bytes,a.sha256 FROM assistant.artifact_search_jobs j
      JOIN assistant.artifacts a ON a.id=j.artifact_id AND a.workspace_id=j.workspace_id WHERE j.workspace_id=${principal.workspace_id}
      AND j.extractor_version=1 AND j.status='pending' AND j.next_attempt_at<=now() AND a.state='ready' AND a.search_indexed=false
      AND EXISTS(SELECT 1 FROM assistant.message_artifacts ma WHERE ma.artifact_id=a.id AND ma.workspace_id=a.workspace_id)
      ORDER BY j.next_attempt_at,j.artifact_id LIMIT 1 FOR UPDATE OF j SKIP LOCKED`;
    if (!rows[0]) return null;
    const row = z
      .object({
        artifact_id: z.uuid(),
        media_type: z.string(),
        name: z.string(),
        bytes: z.coerce.number(),
        sha256: z.string(),
      })
      .parse(rows[0]);
    const lease = DocumentLease.parse({
      ...row,
      lease_id: crypto.randomUUID(),
      version: 1,
      format: documentFormat(row.media_type, row.name),
    });
    await tx`UPDATE assistant.artifact_search_jobs SET status='leased',lease_id=${lease.lease_id},vm_id=${principal.vm_id},lease_expires_at=now()+interval '60 seconds',updated_at=now() WHERE artifact_id=${lease.artifact_id} AND extractor_version=1`;
    return lease;
  });
}

export async function ownedDocument(
  sql: Query,
  principal: Principal,
  request: { readonly artifact: string; readonly identity: z.infer<typeof DocumentLeaseIdentity> },
) {
  const rows =
    await sql`SELECT a.object_key,a.bytes,a.sha256 FROM assistant.artifact_search_jobs j JOIN assistant.artifacts a ON a.id=j.artifact_id AND a.workspace_id=j.workspace_id
    WHERE j.artifact_id=${request.artifact} AND j.extractor_version=${request.identity.version} AND j.workspace_id=${principal.workspace_id}
    AND j.vm_id=${principal.vm_id} AND j.lease_id=${request.identity.lease_id} AND j.status='leased' AND j.lease_expires_at>now() AND a.state='ready'
    AND EXISTS(SELECT 1 FROM assistant.message_artifacts ma WHERE ma.artifact_id=a.id AND ma.workspace_id=a.workspace_id)`;
  if (!rows[0]) throw new DomainError("document_lease_conflict", "Document lease unavailable", 409);
  return z
    .object({ object_key: z.string(), bytes: z.coerce.number(), sha256: z.string() })
    .parse(rows[0]);
}

export async function finishDocument(
  sql: Database,
  principal: Principal,
  request: { readonly artifact: string; readonly result: z.infer<typeof DocumentResult> },
) {
  return sql.begin(async (tx) => {
    const { artifact, result } = request;
    const rows =
      await tx`SELECT status,completed_lease_id,vm_id FROM assistant.artifact_search_jobs WHERE artifact_id=${artifact} AND extractor_version=${result.version} AND workspace_id=${principal.workspace_id} FOR UPDATE`;
    if (!rows[0])
      throw new DomainError("document_lease_conflict", "Document lease unavailable", 409);
    const job = z
      .object({
        status: z.string(),
        completed_lease_id: z.string().nullable(),
        vm_id: z.string().nullable(),
      })
      .parse(rows[0]);
    if (
      job.status === "done" &&
      job.completed_lease_id === result.lease_id &&
      job.vm_id === principal.vm_id
    )
      return;
    const original = await ownedDocument(tx, principal, { artifact, identity: result });
    await tx`SELECT id FROM assistant.artifacts WHERE id=${artifact} AND state='ready' FOR UPDATE`;
    switch (result.kind) {
      case "yield":
        await retryDocument(tx, artifact, "foreground", true);
        return;
      case "retry":
        await retryDocument(tx, artifact, result.code);
        return;
      case "complete": {
        if (result.sha256 !== original.sha256)
          throw new DomainError("document_hash_conflict", "Original hash changed", 409);
        const text = result.text?.replaceAll("\0", "") || null;
        if ((result.code === "text") !== Boolean(text) || (text && result.code !== "text"))
          throw new DomainError("invalid_document_result", "Inconsistent result");
        const updated =
          await tx`UPDATE assistant.artifacts SET search_text=${text},search_text_truncated=${result.truncated},search_indexed=true
          WHERE id=${artifact} AND state='ready' AND sha256=${result.sha256} AND EXISTS(SELECT 1 FROM assistant.message_artifacts WHERE artifact_id=${artifact}) RETURNING id`;
        if (!updated[0])
          throw new DomainError("document_lease_conflict", "Document unavailable", 409);
        await tx`UPDATE assistant.artifact_search_jobs SET status='done',outcome=${result.code},completed_lease_id=lease_id,lease_id=NULL,lease_expires_at=NULL,updated_at=now() WHERE artifact_id=${artifact} AND extractor_version=1`;
        return;
      }
    }
  });
}
