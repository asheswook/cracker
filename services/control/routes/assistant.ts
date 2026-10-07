import { Hono } from "hono";
import { z } from "zod";
import { Conversation, DomainError, Id, Onboarding, Persona } from "../../../packages/protocol";
import type { AppEnv } from "../auth";
import type { Database } from "../db";

const Settings = z.object({ instructions: z.string(), persona: Persona, onboarding: Onboarding, revision: Id });
const SettingsUpdate = z
  .object({
    expected_revision: Id.optional(),
    instructions: z.string().max(100000).optional(),
    persona: Persona.optional(),
    onboarding: z.object({ status: z.enum(["completed", "skipped"]) }).strict().optional(),
  })
  .strict()
  .refine((body) => body.instructions !== undefined || body.persona !== undefined || body.onboarding !== undefined);

export function assistantRoutes(sql: Database) {
  const app = new Hono<AppEnv>();
  app.get("/assistant/conversation", async (c) => {
    const rows =
      await sql`SELECT c.* FROM assistant.workspaces w JOIN assistant.conversations c ON c.workspace_id=w.id AND c.id=w.default_conversation_id WHERE w.id=${c.get("principal").workspace_id}`;
    c.header("Cache-Control", "no-store");
    return c.json({ conversation: rows[0] ? Conversation.parse(rows[0]) : null });
  });
  app.post("/assistant/conversation", async (c) => {
    const workspace = c.get("principal").workspace_id;
    const conversation = await sql.begin(async (tx) => {
      const rows =
        await tx`SELECT default_conversation_id FROM assistant.workspaces WHERE id=${workspace} FOR UPDATE`;
      if (!rows[0]) throw new DomainError("not_found", "Workspace not found", 404);
      const existing = z.object({ default_conversation_id: Id.nullable() }).parse(rows[0]);
      if (existing.default_conversation_id) {
        const found =
          await tx`SELECT * FROM assistant.conversations WHERE workspace_id=${workspace} AND id=${existing.default_conversation_id}`;
        return Conversation.parse(found[0]);
      }
      const created = Conversation.parse(
        (
          await tx`INSERT INTO assistant.conversations(workspace_id,title) VALUES(${workspace},'Assistant') RETURNING *`
        )[0],
      );
      await tx`UPDATE assistant.workspaces SET default_conversation_id=${created.id} WHERE id=${workspace}`;
      return created;
    });
    c.header("Cache-Control", "no-store");
    return c.json({ conversation });
  });
  app.get("/settings", async (c) => {
    const rows =
      await sql`SELECT settings_revision AS revision,instructions,json_build_object('name',persona_name,'role',persona_role,'style',persona_style) AS persona,json_build_object('status',onboarding_status,'updated_at',onboarding_updated_at) AS onboarding FROM assistant.workspaces WHERE id=${c.get("principal").workspace_id}`;
    c.header("Cache-Control", "no-store");
    return c.json(Settings.parse(rows[0]));
  });
  app.put("/settings", async (c) => {
    const body = SettingsUpdate.parse(await c.req.json());
    if (!body.expected_revision) throw new DomainError('settings_version_required', 'Reopen settings before saving', 409);
    const workspace = c.get('principal').workspace_id;
    const result = await sql.begin(async tx => {
      const rows = await tx`SELECT settings_revision AS revision,instructions,json_build_object('name',persona_name,'role',persona_role,'style',persona_style) AS persona,json_build_object('status',onboarding_status,'updated_at',onboarding_updated_at) AS onboarding FROM assistant.workspaces WHERE id=${workspace} FOR UPDATE`;
      if (!rows[0]) throw new DomainError('not_found', 'Workspace not found', 404);
      const current = Settings.parse(rows[0]);
      const same = (body.instructions === undefined || body.instructions === current.instructions)
        && (body.persona === undefined || (body.persona.name === current.persona.name && body.persona.role === current.persona.role && body.persona.style === current.persona.style))
        && (body.onboarding === undefined || body.onboarding.status === current.onboarding.status);
      if (same) return current;
      if (body.expected_revision !== current.revision) throw new DomainError('stale_revision', 'Settings changed on another device', 409);
      const changed = await tx`UPDATE assistant.workspaces SET settings_revision=gen_random_uuid(),instructions=COALESCE(${body.instructions ?? null},instructions),persona_name=COALESCE(${body.persona?.name ?? null},persona_name),persona_role=COALESCE(${body.persona?.role ?? null},persona_role),persona_style=COALESCE(${body.persona?.style ?? null},persona_style),onboarding_updated_at=CASE WHEN ${body.onboarding?.status ?? null} IS DISTINCT FROM onboarding_status AND ${body.onboarding !== undefined} THEN now() ELSE onboarding_updated_at END,onboarding_status=COALESCE(${body.onboarding?.status ?? null},onboarding_status) WHERE id=${workspace} RETURNING settings_revision AS revision,instructions,json_build_object('name',persona_name,'role',persona_role,'style',persona_style) AS persona,json_build_object('status',onboarding_status,'updated_at',onboarding_updated_at) AS onboarding`;
      return Settings.parse(changed[0]);
    });
    c.header("Cache-Control", "no-store");
    return c.json(result);
  });
  return app;
}
