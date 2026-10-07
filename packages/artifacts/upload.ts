import { z } from "zod";
import type { Database } from "../../services/control/db";
import { Artifact, DomainError, Id } from "../protocol";
import { purgeArtifact } from "./cleanup";
import { artifactSearchText } from "./search-text.ts";
import { documentFormat } from "./document-types.ts";
import { type ArtifactScope, reserveUpload } from "./reservation";
import { type ArtifactStore } from "./store";
import { LEGACY_ARTIFACT_BYTES } from "./limits";
import { streamingUpload } from "./streaming-upload";

async function readUpload(request: Request) {
  const reader = request.body?.getReader();
  const chunks: Uint8Array[] = [];
  let length = 0;
  if (reader) {
    try {
      while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        length += value.byteLength;
        if (length > LEGACY_ARTIFACT_BYTES) {
          await reader.cancel();
          throw new DomainError("artifact_too_large", "Files over 10 MiB require size and SHA-256 upload headers", 413);
        }
        chunks.push(value);
      }
    } finally {
      reader.releaseLock();
    }
  }
  const bytes = new Uint8Array(length);
  let offset = 0;
  for (const chunk of chunks) {
    bytes.set(chunk, offset);
    offset += chunk.length;
  }
  const digest = new Uint8Array(await crypto.subtle.digest("SHA-256", bytes));
  return {
    bytes,
    sha256: Array.from(digest, (byte) => byte.toString(16).padStart(2, "0")).join(""),
  };
}
export async function uploadArtifact(
  sql: Database,
  store: ArtifactStore,
  input: { readonly scope: ArtifactScope; readonly request: Request },
) {
  const id = Id.parse(input.request.headers.get("X-Artifact-Id"));
  let decodedName: string;
  try {
    decodedName = decodeURIComponent(input.request.headers.get("X-Artifact-Name") ?? "");
  } catch (error) {
    if (error instanceof URIError)
      throw new DomainError("invalid_filename", "Filename encoding invalid");
    throw error;
  }
  const name = z
    .string()
    .trim()
    .min(1)
    .max(240)
    .refine(
      (value) =>
        !value.includes("/") &&
        !value.includes("\\") &&
        Array.from(value).every(
          (character) => character.charCodeAt(0) >= 32 && character.charCodeAt(0) !== 127,
        ),
    )
    .refine((value) => value !== "." && value !== "..")
    .parse(decodedName);
  const mediaType = z
    .string()
    .max(127)
    .regex(/^[a-z0-9!#$&^_.+-]+\/[a-z0-9!#$&^_.+-]+$/)
    .parse(
      (input.request.headers.get("Content-Type") ?? "application/octet-stream")
        .split(";")[0]
        ?.trim()
        .toLowerCase(),
    );
  const stream = streamingUpload(input.request);
  const legacy = stream ? null : await readUpload(input.request);
  const data = stream ?? (legacy && { bytes: legacy.bytes.length, sha256: legacy.sha256,
    body: new Blob([legacy.bytes]).stream(), finish: (type: string) => artifactSearchText(legacy.bytes, type) });
  if (!data) throw new DomainError("artifact_body_missing", "File body missing", 400);
  const reserved = await reserveUpload(sql, {
    scope: input.scope,
    metadata: { id, name, mediaType, bytes: data.bytes, sha256: data.sha256 },
  }).catch(async (error: unknown) => { await data.body.cancel(error); throw error; });
  switch (reserved.kind) {
    case "existing":
      await data.body.cancel();
      return reserved.artifact;
    case "reserved":
      break;
    default:
      throw new DomainError("invalid_reservation", "File reservation failed", 503);
  }
  try {
    await store.put(reserved.objectKey, data.body, {
      bytes: data.bytes,
      mediaType,
      sha256: data.sha256,
    });
    const indexed = data.finish(mediaType);
    const ready =
      await sql`UPDATE assistant.artifacts SET state='ready',search_text=${indexed.text},search_text_truncated=${indexed.truncated},search_indexed=${documentFormat(mediaType,name) === null} WHERE id=${id} AND state='uploading' AND lease_id=${reserved.leaseId} RETURNING *`;
    if (!ready[0])
      throw new DomainError(
        "artifact_lease_expired",
        "Upload lease changed; retry with the same ID",
        409,
      );
    return Artifact.parse(ready[0]);
  } catch (error) {
    const failed =
      await sql`UPDATE assistant.artifacts SET state=CASE WHEN state='deleted' THEN 'deleted' ELSE 'failed' END,purged_at=NULL WHERE id=${id} AND (lease_id=${reserved.leaseId} OR state IN ('failed','deleted')) AND state IN ('uploading','failed','deleted') RETURNING id`;
    if (failed[0]) {
      try {
        await purgeArtifact(sql, store, id);
      } catch (cleanupError) {
        if (!(cleanupError instanceof Error)) throw cleanupError;
        console.error(JSON.stringify({ event: "artifact.cleanup_failed", artifact_id: id }));
      }
    }
    if (error instanceof DomainError) throw error;
    if (error instanceof Error)
      throw new DomainError(
        "artifact_storage_failed",
        "File storage unavailable; retry with the same ID",
        503,
      );
    throw error;
  }
}
