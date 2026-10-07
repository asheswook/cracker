import { Hono } from "hono";
import { z } from "zod";
import type { AppEnv } from "../../services/control/auth.ts";
import type { Database } from "../../services/control/db.ts";
import { DomainError } from "../protocol/index.ts";
import {
  claimDocument,
  documentIdle,
  finishDocument,
  ownedDocument,
  retryDocument,
} from "./document-index.ts";
import { DocumentLeaseIdentity, DocumentResult } from "./document-types.ts";
import type { ArtifactStore } from "./store.ts";

export function documentIndexRoutes(sql: Database, store: ArtifactStore | undefined) {
  const app = new Hono<AppEnv>();
  app.post("/artifact-index/claim", async (c) => {
    if (!store)
      throw new DomainError("artifact_storage_unavailable", "File storage unavailable", 503);
    return c.json({ job: await claimDocument(sql, c.get("principal")) });
  });
  app.get("/artifact-index/:id/content", async (c) => {
    const artifact = z.uuid().parse(c.req.param("id"));
    const identity = DocumentLeaseIdentity.parse({
      lease_id: c.req.header("X-Document-Lease"),
      version: Number(c.req.header("X-Document-Version")),
    });
    const original = await ownedDocument(sql, c.get("principal"), { artifact, identity });
    const object = await store?.get(original.object_key);
    if (!object || object.size !== original.bytes)
      throw new DomainError("artifact_storage_unavailable", "File storage unavailable", 503);
    return new Response(object.body, {
      headers: {
        "Content-Type": "application/octet-stream",
        "Content-Length": String(original.bytes),
        "Cache-Control": "private, no-store",
        "X-Content-Type-Options": "nosniff",
      },
    });
  });
  app.post("/artifact-index/:id/lease", async (c) => {
    const principal = c.get("principal"),
      artifact = z.uuid().parse(c.req.param("id"));
    const identity = DocumentLeaseIdentity.parse(await c.req.json());
    const proceed = await sql.begin(async (tx) => {
      await tx`SELECT artifact_id FROM assistant.artifact_search_jobs WHERE artifact_id=${artifact} AND extractor_version=1 FOR UPDATE`;
      await ownedDocument(tx, principal, { artifact, identity });
      if (!(await documentIdle(tx, principal))) {
        await retryDocument(tx, artifact, "foreground", true);
        return false;
      }
      await tx`UPDATE assistant.artifact_search_jobs SET lease_expires_at=now()+interval '60 seconds',updated_at=now() WHERE artifact_id=${artifact} AND extractor_version=1`;
      return true;
    });
    return c.json({ continue: proceed });
  });
  app.post("/artifact-index/:id/result", async (c) => {
    await finishDocument(sql, c.get("principal"), {
      artifact: z.uuid().parse(c.req.param("id")),
      result: DocumentResult.parse(await c.req.json()),
    });
    return c.json({ accepted: true });
  });
  return app;
}
