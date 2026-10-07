import { Hono } from "hono";
import { z } from "zod";
import { PriorSourceRequest, WorkSearchRequest } from "../../../packages/protocol/work-search.ts";
import { indexPriorText } from "../../../packages/artifacts/search-text.ts";
import { documentCoverage } from "../../../packages/artifacts/document-coverage.ts";
import type { ArtifactStore } from "../../../packages/artifacts/store.ts";
import type { AppEnv } from "../auth.ts";
import type { Database } from "../db.ts";
import { authorizeReferenceRun, readPriorSource, searchWork } from "../repository/work-search.ts";

export function workSearchRoutes(sql: Database, store: ArtifactStore | undefined, daemon = false) {
  const app = new Hono<AppEnv>();
  app.post(daemon ? "/context/:run/search" : "/search", async c => {
    const principal = c.get("principal"), request = WorkSearchRequest.parse(await c.req.json());
    if (daemon) await authorizeReferenceRun(sql, principal, z.uuid().parse(c.req.param("run")));
    const remaining = await indexPriorText(sql, store, principal.workspace_id);
    const result = await searchWork(sql, principal.workspace_id, request);
    return c.json({...result,unindexed_text_files:remaining,...await documentCoverage(sql,principal.workspace_id,request)});
  });
  if (daemon) app.post("/context/:run/prior-source", async c => {
    const principal = c.get("principal"), request = PriorSourceRequest.parse(await c.req.json());
    await authorizeReferenceRun(sql, principal, z.uuid().parse(c.req.param("run")));
    return c.json(await readPriorSource(sql, principal, request.source_message_id));
  });
  if (!daemon) app.get("/sources/:id", async c => c.json(await readPriorSource(sql,c.get("principal"),z.uuid().parse(c.req.param("id")))));
  return app;
}
