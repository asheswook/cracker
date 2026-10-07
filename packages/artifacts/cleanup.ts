import { z } from "zod";
import type { Database } from "../../services/control/db";
import type { ArtifactStore } from "./store";
export async function purgeArtifact(
  sql: Database,
  store: ArtifactStore,
  id: string,
): Promise<boolean> {
  const candidates = await sql`SELECT workspace_id FROM assistant.artifacts WHERE id=${id}`;
  if (!candidates[0]) return false;
  const workspace = z.object({ workspace_id: z.uuid() }).parse(candidates[0]).workspace_id;
  return sql.begin(async (tx) => {
    await tx`SELECT id FROM assistant.workspaces WHERE id=${workspace} FOR UPDATE`;
    const pending =
      await tx`SELECT object_key FROM assistant.artifacts WHERE id=${id} AND state IN ('failed','deleted') AND purged_at IS NULL FOR UPDATE`;
    if (!pending[0]) return false;
    await store.delete(z.object({ object_key: z.string() }).parse(pending[0]).object_key);
    await tx`UPDATE assistant.artifacts SET purged_at=now() WHERE id=${id}`;
    return true;
  });
}
export async function cleanupArtifacts(sql: Database, store: ArtifactStore): Promise<number> {
  await sql`UPDATE assistant.artifacts SET state='failed' WHERE state='uploading' AND lease_expires_at<now()`;
  const pending = z
    .array(z.object({ id: z.uuid() }))
    .parse(
      await sql`SELECT id FROM assistant.artifacts WHERE state IN ('failed','deleted') AND purged_at IS NULL ORDER BY created_at LIMIT 100`,
    );
  let purged = 0;
  for (const artifact of pending) {
    try {
      if (await purgeArtifact(sql, store, artifact.id)) purged++;
    } catch (error) {
      if (!(error instanceof Error)) throw error;
      console.error(JSON.stringify({ event: "artifact.cleanup_failed", artifact_id: artifact.id }));
    }
  }
  return purged;
}
