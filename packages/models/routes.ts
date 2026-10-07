import { Hono } from "hono";
import { z } from "zod";
import type { AppEnv } from "../../services/control/auth.ts";
import type { Database } from "../../services/control/db.ts";
import { ModelDefaults, SaveModelSettings } from "./schema.ts";
import { accessCurrentModel, accessRunModel, modelSettings, saveModel } from "./repository.ts";

export function modelClientRoutes(sql: Database, encryptionKey?: string): Hono<AppEnv> {
  const app = new Hono<AppEnv>();
  app.use("*", async (c, next) => { c.header("Cache-Control", "no-store"); await next(); });
  app.get("/", async c => c.json(await sql.begin(tx => modelSettings(tx, { workspace: c.get("principal").workspace_id, vm: z.uuid().parse(c.req.query("vm_id")) }))));
  app.put("/", async c => {
    const input = SaveModelSettings.parse(await c.req.json());
    return c.json(await sql.begin(tx => saveModel(tx, { workspace: c.get("principal").workspace_id, encryptionKey }, input)));
  });
  return app;
}
export function modelDaemonRoutes(sql: Database, encryptionKey?: string): Hono<AppEnv> {
  const app = new Hono<AppEnv>();
  app.use("*", async (c, next) => { c.header("Cache-Control", "no-store"); await next(); });
  app.post("/defaults", async c => {
    const input = ModelDefaults.parse(await c.req.json()), p = c.get("principal");
    await sql`INSERT INTO assistant.vm_model_defaults(vm_id,workspace_id,configuration) VALUES(${p.vm_id},${p.workspace_id},${JSON.stringify(input)}::text::jsonb) ON CONFLICT(vm_id) DO UPDATE SET configuration=excluded.configuration,updated_at=now()`;
    return c.json({ accepted: true });
  });
  app.get("/runs/:id", async c => c.json(await accessRunModel(sql, { principal: c.get("principal"), encryptionKey }, z.uuid().parse(c.req.param("id")))));
  app.get("/current", async c => {
    const p = c.get("principal");
    return c.json(await accessCurrentModel(sql, { workspace: p.workspace_id, vm: z.uuid().parse(p.vm_id), encryptionKey }));
  });
  return app;
}
