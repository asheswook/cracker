import { z } from "zod";
import type { Database } from "../../services/control/db.ts";
import type { ArtifactStore } from "./store.ts";

const maximumBytes = 512 * 1024;
export function artifactSearchText(bytes: Uint8Array, mediaType: string) {
  if (!(mediaType.startsWith("text/") || ["application/json", "application/xml", "application/javascript"].includes(mediaType))) return { text: null, truncated: false };
  const text = new TextDecoder().decode(bytes.subarray(0, maximumBytes)).replaceAll("\0", "");
  return { text: text.slice(0, 200000), truncated: bytes.length > maximumBytes || text.length > 200000 };
}

export async function indexPriorText(sql: Database, store: ArtifactStore | undefined, workspace: string): Promise<number> {
  const pending = await sql`SELECT id,object_key,media_type,bytes FROM assistant.artifacts WHERE workspace_id=${workspace} AND state='ready' AND search_indexed=false AND (media_type LIKE 'text/%' OR media_type IN ('application/json','application/xml','application/javascript')) ORDER BY created_at DESC,id DESC LIMIT 8`;
  if (store) for (const raw of pending) {
    const row = z.object({ id:z.uuid(), object_key:z.string(), media_type:z.string(), bytes:z.coerce.number() }).parse(raw);
    const object = await store.get(row.object_key);
    if (!object || object.size !== row.bytes) continue;
    const reader = object.body.getReader(), chunks: Uint8Array[] = [];
    let length = 0;
    try {
      while (length < maximumBytes) {
        const next = await reader.read(); if (next.done) break;
        const part = next.value.subarray(0, maximumBytes - length); chunks.push(part); length += part.length;
      }
      await reader.cancel();
    } finally { reader.releaseLock(); }
    const bytes = new Uint8Array(length); let offset = 0;
    for (const chunk of chunks) { bytes.set(chunk, offset); offset += chunk.length; }
    const indexed = artifactSearchText(bytes, row.media_type);
    await sql`UPDATE assistant.artifacts SET search_text=${indexed.text},search_text_truncated=${indexed.truncated || row.bytes > maximumBytes},search_indexed=true WHERE id=${row.id} AND workspace_id=${workspace} AND state='ready'`;
  }
  return z.object({ count:z.coerce.number() }).parse((await sql`SELECT count(*) AS count FROM assistant.artifacts WHERE workspace_id=${workspace} AND state='ready' AND search_indexed=false AND (media_type LIKE 'text/%' OR media_type IN ('application/json','application/xml','application/javascript'))`)[0]).count;
}
