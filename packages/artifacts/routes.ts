import { Hono } from "hono";
import { z } from "zod";
import type { AppEnv } from "../../services/control/auth";
import type { Database } from "../../services/control/db";
import { conversation } from "../../services/control/repository/common";
import { Artifact, DomainError, Id } from "../protocol";
import { purgeArtifact } from "./cleanup";
import { ArtifactRow, authorizeArtifactRun } from "./reservation";
import type { ArtifactStore } from "./store";
import { uploadArtifact } from "./upload";
import { authorizeReferenceRun } from "../../services/control/repository/work-search.ts";
import { documentIndexRoutes } from "./document-index-routes.ts";
import { readArtifact } from "./read";
import { executionPolicy } from "../../services/control/repository/execution-policy";
export function artifactRoutes(sql: Database, store: ArtifactStore | undefined, daemon = false) {
  const app = new Hono<AppEnv>();
  if (daemon) app.route("/", documentIndexRoutes(sql, store));
  const storage = () => {
    if (!store)
      throw new DomainError("artifact_storage_unavailable", "File storage is not configured", 503);
    return store;
  };
  if (daemon) app.get("/artifacts/read", async c => {
    const principal = c.get("principal"), run = Id.parse(c.req.query("run_id"));
    await authorizeReferenceRun(sql, principal, run);
    const task = (await sql`SELECT task_id FROM assistant.runs WHERE id=${run} AND workspace_id=${principal.workspace_id}`)[0]!;
    const policy = (await executionPolicy(sql, principal.workspace_id, String(task['task_id']))).run_policy;
    if (policy === 'read_only' || policy === 'send_once')
      throw new DomainError("tool_not_allowed", "This run cannot read artifacts", 403);
    return c.json(await readArtifact(sql, store, principal.workspace_id, {
      series: c.req.query("series"), artifact_id: c.req.query("artifact_id"),
    }));
  });
  app.post("/conversations/:id/artifacts", async (c) => {
    const conversation = Id.parse(c.req.param("id")),
      runId = Id.optional().parse(c.req.query("run_id"));
    const artifact = await uploadArtifact(sql, storage(), {
      scope: { principal: c.get("principal"), conversation, ...(runId ? { runId } : {}) },
      request: c.req.raw,
    });
    return c.json({ artifact }, 201);
  });
  app.get("/artifacts/:id/content", async (c) => {
    const principal = c.get("principal"),
      id = Id.parse(c.req.param("id")),
      runId = Id.optional().parse(c.req.query("run_id"));
    const rows =
      await sql`SELECT * FROM assistant.artifacts WHERE id=${id} AND workspace_id=${principal.workspace_id} AND state='ready'`;
    if (!rows[0]) throw new DomainError("not_found", "File not found", 404);
    const artifact = ArtifactRow.parse(rows[0]);
    const priorSource = Id.optional().parse(c.req.query("prior_source_message_id"));
    if (daemon && priorSource) {
      await authorizeReferenceRun(sql, principal, Id.parse(runId));
      const linked = await sql`SELECT m.id FROM assistant.message_artifacts ma JOIN assistant.messages m ON m.id=ma.message_id WHERE ma.artifact_id=${id} AND m.id=${priorSource} AND m.workspace_id=${principal.workspace_id}`;
      if (!linked[0]) throw new DomainError("not_found", "Artifact source not found", 404);
    } else await authorizeArtifactRun(sql, {
      principal,
      conversation: artifact.conversation_id,
      ...(runId ? { runId } : {}),
    },false,false);
    const object = await storage().get(artifact.object_key);
    if (!object || object.size !== artifact.bytes)
      throw new DomainError("artifact_storage_unavailable", "Stored file unavailable", 503);
    return new Response(object.body, {
      headers: {
        "Content-Type": artifact.media_type,
        "Content-Length": String(artifact.bytes),
        "Content-Disposition": `attachment; filename*=UTF-8''${encodeURIComponent(artifact.name)}`,
        "X-Content-Type-Options": "nosniff",
        "Content-Security-Policy": "sandbox; default-src 'none'",
        "Cache-Control": "private, no-store",
        ETag: `"${artifact.sha256}"`,
      },
    });
  });
  if (!daemon) {
    app.get("/conversations/:id/artifacts", async (c) => {
      const workspace = c.get("principal").workspace_id,
        id = Id.parse(c.req.param("id"));
      await conversation(sql, workspace, id);
      return c.json({
        artifacts: z
          .array(Artifact)
          .parse(
            await sql`SELECT * FROM assistant.artifacts WHERE workspace_id=${workspace} AND conversation_id=${id} AND state IN ('ready','deleted') ORDER BY created_at`,
          ),
      });
    });
    app.delete("/artifacts/:id", async (c) => {
      const workspace = c.get("principal").workspace_id,
        id = Id.parse(c.req.param("id")),
        objectStore = storage();
      const artifact = await sql.begin(async (tx) => {
        await tx`SELECT id FROM assistant.workspaces WHERE id=${workspace} FOR UPDATE`;
        await tx`UPDATE assistant.artifact_search_jobs SET status='cancelled',lease_id=NULL,vm_id=NULL,lease_expires_at=NULL,updated_at=now() WHERE artifact_id=${id} AND workspace_id=${workspace} AND status IN ('pending','leased')`;
        const rows =
          await tx`SELECT * FROM assistant.artifacts WHERE id=${id} AND workspace_id=${workspace} FOR UPDATE`;
        if (!rows[0]) throw new DomainError("not_found", "File not found", 404);
        const row = ArtifactRow.parse(rows[0]);
        if (row.state === "uploading")
          throw new DomainError("artifact_uploading", "Upload is still in progress", 409);
        await tx`UPDATE assistant.artifacts SET state='deleted',deleted_at=COALESCE(deleted_at,now()),search_text=NULL,search_text_truncated=false WHERE id=${id}`;
        return row;
      });
      try {
        await purgeArtifact(sql, objectStore, artifact.id);
      } catch (error) {
        if (error instanceof Error)
          throw new DomainError(
            "artifact_delete_pending",
            "File hidden; storage cleanup pending retry",
            503,
          );
        throw error;
      }
      return c.json({ deleted: true });
    });
  }
  return app;
}
