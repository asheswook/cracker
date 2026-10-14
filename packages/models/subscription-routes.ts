import { Hono } from "hono";
import { z } from "zod";
import type { AppEnv } from "../../services/control/auth.ts";
import type { Database, Query } from "../../services/control/db.ts";
import { DomainError } from "../protocol/index.ts";
import { seal, unseal } from "../extensions/secrets.ts";
import { ownModelVm } from "./repository.ts";
import { SubscriptionClaim, SubscriptionCommand, SubscriptionReply, SubscriptionResult } from "./subscription-schema.ts";

async function expire(sql: Query, vm: string) {
  await sql`DELETE FROM assistant.subscription_requests WHERE vm_id=${vm} AND expires_at<=now()`;
}
export function subscriptionClientRoutes(sql: Database, encryptionKey?: string) {
  const app = new Hono<AppEnv>();
  app.use("*", async (c, next) => { c.header("Cache-Control", "no-store"); await next(); });
  app.post("/", async c => {
    const input = z.object({ vm_id: z.uuid(), request_id: z.uuid(), command: SubscriptionCommand }).strict().parse(await c.req.json());
    const workspace = c.get("principal").workspace_id;
    return c.json(await sql.begin(async tx => {
      await ownModelVm(tx, { workspace, vm: input.vm_id });
      await expire(tx, input.vm_id);
      const previous = (await tx`SELECT request_id,status,result FROM assistant.subscription_requests WHERE request_id=${input.request_id}`)[0];
      if (previous) throw new DomainError("idempotency_conflict", "Request already exists", 409);
      const queued = await tx`SELECT request_id FROM assistant.subscription_requests WHERE vm_id=${input.vm_id} AND status IN ('pending','running')`;
      if (queued.length >= 16) throw new DomainError("command_pending", "잠시 후 다시 시도해 주세요.", 409);
      const { command } = input;
      const cipher = command.action === "callback" ? await seal({ redirect_url: command.redirect_url }, encryptionKey) : null;
      const stored = command.action === "callback" ? { action: command.action, state: command.state } : command;
      await tx`INSERT INTO assistant.subscription_requests(request_id,workspace_id,vm_id,command,callback_cipher) VALUES(${input.request_id},${workspace},${input.vm_id},${JSON.stringify(stored)}::text::jsonb,${cipher})`;
      return SubscriptionReply.parse({ request_id: input.request_id, status: "pending", result: null });
    }));
  });
  app.get("/:id", async c => {
    const request = z.uuid().parse(c.req.param("id")), vm = z.uuid().parse(c.req.query("vm_id")), workspace = c.get("principal").workspace_id;
    return c.json(await sql.begin(async tx => {
      await ownModelVm(tx, { workspace, vm });
      await expire(tx, vm);
      const row = (await tx`SELECT request_id,status,result FROM assistant.subscription_requests WHERE request_id=${request} AND workspace_id=${workspace} AND vm_id=${vm}`)[0];
      if (!row) throw new DomainError("not_found", "요청이 만료됐어요. 다시 시도해 주세요.", 404);
      return SubscriptionReply.parse(row);
    }));
  });
  return app;
}
export function subscriptionDaemonRoutes(sql: Database, encryptionKey?: string) {
  const app = new Hono<AppEnv>();
  app.use("*", async (c, next) => { c.header("Cache-Control", "no-store"); await next(); });
  app.post("/claim", async c => {
    const p = c.get("principal"), vm = z.uuid().parse(p.vm_id);
    const { claim_id } = z.object({ claim_id: z.uuid() }).strict().parse(await c.req.json());
    return c.json(await sql.begin(async tx => {
      await ownModelVm(tx, { workspace: p.workspace_id, vm });
      await expire(tx, vm);
      const previous = (await tx`SELECT request_id,command,callback_cipher FROM assistant.subscription_requests WHERE vm_id=${vm} AND workspace_id=${p.workspace_id} AND claim_id=${claim_id} AND status='running'`)[0];
      const row = previous ?? (await tx`UPDATE assistant.subscription_requests SET status='running',claim_id=${claim_id} WHERE request_id=(SELECT request_id FROM assistant.subscription_requests WHERE vm_id=${vm} AND workspace_id=${p.workspace_id} AND status='pending' ORDER BY created_at LIMIT 1 FOR UPDATE SKIP LOCKED) RETURNING request_id,command,callback_cipher`)[0];
      if (!row) return { request: null };
      const stored = z.object({ request_id: z.uuid(), command: z.record(z.string(), z.unknown()), callback_cipher: z.string().nullable() }).parse(row);
      const callback = stored.callback_cipher ? await unseal(stored.callback_cipher, encryptionKey) : {};
      return { request: SubscriptionClaim.parse({ request_id: stored.request_id, command: { ...stored.command, ...callback } }) };
    }));
  });
  app.post("/observed", async c => {
    const input = z.object({ request_id: z.uuid(), result: SubscriptionResult.nullable() }).strict().parse(await c.req.json());
    const p = c.get("principal"), vm = z.uuid().parse(p.vm_id);
    const rows = await sql`UPDATE assistant.subscription_requests SET status=${input.result ? "completed" : "failed"},result=${JSON.stringify(input.result)}::text::jsonb,callback_cipher=NULL WHERE request_id=${input.request_id} AND workspace_id=${p.workspace_id} AND vm_id=${vm} AND status IN ('running','completed','failed') AND expires_at>now() AND (${input.result === null} OR command->>'action'=${input.result?.action ?? ""}) RETURNING request_id`;
    if (!rows.length) throw new DomainError("stale_configuration", "Request expired", 409);
    return c.json({ accepted: true });
  });
  return app;
}
