import { Hono } from "hono";
import { z } from "zod";
import type { AppEnv } from "../../services/control/auth.ts";
import type { Database } from "../../services/control/db.ts";
import { DomainError } from "../protocol/index.ts";
import { seal } from "../extensions/secrets.ts";
import { Registration, Viewing, type PushConfig } from "./schema.ts";
import { normalizeConfig, type NotificationConfig } from "./config.ts";
export function notificationRoutes(
  sql: Database,
  input: NotificationConfig | PushConfig | undefined,
) {
  const config = normalizeConfig(input ?? {});
  const app = new Hono<AppEnv>();
  app.put('/viewing', async (c) => {
    const body = Viewing.parse(await c.req.json());
    const principal = c.get('principal');
    if (body.conversation_id) {
      await sql`INSERT INTO assistant.notification_conversation_viewing(workspace_id,credential_hash,session_hash,installation_id,page_id,conversation_id,sequence,expires_at)
        SELECT c.workspace_id,${principal.credential_hash ?? ''},${principal.session_hash ?? null},${body.installation_id},${body.page_id},c.id,${body.sequence},
          CASE WHEN ${body.active} AND to_timestamp(${body.observed_at}/1000.0) BETWEEN clock_timestamp()-interval '3 seconds' AND clock_timestamp()+interval '1 second'
            THEN LEAST(clock_timestamp()+interval '3 seconds',to_timestamp(${body.observed_at}/1000.0)+interval '3 seconds') ELSE clock_timestamp() END
        FROM assistant.conversations c WHERE c.id=${body.conversation_id} AND c.workspace_id=${principal.workspace_id}
        ON CONFLICT(workspace_id,installation_id,page_id) DO UPDATE SET sequence=excluded.sequence,conversation_id=excluded.conversation_id,expires_at=excluded.expires_at,updated_at=clock_timestamp()
          WHERE assistant.notification_conversation_viewing.sequence<excluded.sequence
            AND assistant.notification_conversation_viewing.credential_hash=excluded.credential_hash
            AND assistant.notification_conversation_viewing.session_hash IS NOT DISTINCT FROM excluded.session_hash`;
      if (body.sequence === 1) await sql`DELETE FROM assistant.notification_conversation_viewing
        WHERE workspace_id=${principal.workspace_id} AND credential_hash=${principal.credential_hash ?? ''} AND updated_at<now()-interval '1 day'`;
      return c.body(null, 204);
    }
    await sql`INSERT INTO assistant.notification_viewing(subscription_id,page_id,sequence,expires_at)
      SELECT s.id,${body.page_id},${body.sequence},
        CASE WHEN ${body.active} AND to_timestamp(${body.observed_at}/1000.0) BETWEEN clock_timestamp()-interval '3 seconds' AND clock_timestamp()+interval '1 second'
          THEN LEAST(clock_timestamp()+interval '3 seconds',to_timestamp(${body.observed_at}/1000.0)+interval '3 seconds') ELSE clock_timestamp() END
      FROM assistant.push_subscriptions s
      WHERE s.workspace_id=${principal.workspace_id} AND s.credential_hash=${principal.credential_hash ?? ''}
        AND s.session_hash IS NOT DISTINCT FROM ${principal.session_hash ?? null}
        AND s.installation_id=${body.installation_id} AND s.transport='web' AND s.enabled
      ON CONFLICT(subscription_id,page_id) DO UPDATE SET sequence=excluded.sequence,expires_at=excluded.expires_at,updated_at=clock_timestamp()
        WHERE assistant.notification_viewing.sequence<excluded.sequence`;
    // Old page tombstones outlive any accepted heartbeat; current pages stay bounded by their subscription.
    if (body.sequence === 1) await sql`DELETE FROM assistant.notification_viewing v USING assistant.push_subscriptions s
      WHERE v.subscription_id=s.id AND s.workspace_id=${principal.workspace_id}
        AND s.credential_hash=${principal.credential_hash ?? ''} AND v.updated_at<now()-interval '1 day'`;
    return c.body(null, 204);
  });
  app.get("/", async (c) => {
    const principal = c.get("principal"),
      installation = z.uuid().parse(c.req.query("installation_id")),
      transport = z.enum(["web", "fcm"]).default("web").parse(c.req.query("transport"));
    const row = z
      .object({ enabled: z.boolean() })
      .optional()
      .parse(
        (
          await sql`SELECT enabled FROM assistant.push_subscriptions WHERE workspace_id=${principal.workspace_id} AND credential_hash=${principal.credential_hash ?? ""} AND installation_id=${installation} AND transport=${transport} AND session_hash IS NOT DISTINCT FROM ${principal.session_hash ?? null}`
        )[0],
      );
    const preference = z.object({ notification_show_content: z.boolean() }).parse(
      (await sql`SELECT notification_show_content FROM assistant.workspaces WHERE id=${principal.workspace_id}`)[0],
    );
    return c.json({
      show_content: preference.notification_show_content,
      configured: !!config[transport],
      public_key: transport === "web" ? (config.web?.publicKey ?? null) : null,
      enabled: row?.enabled ?? false,
    });
  });
  app.put("/preferences", async (c) => {
    const body = z.object({ show_content: z.boolean() }).strict().parse(await c.req.json());
    const principal = c.get("principal");
    await sql`UPDATE assistant.workspaces SET notification_show_content=${body.show_content} WHERE id=${principal.workspace_id}`;
    return c.json(body);
  });
  app.put("/subscription", async (c) => {
    const body = Registration.parse(await c.req.json());
    const transport = "transport" in body.subscription ? body.subscription.transport : "web";
    const selected = config[transport];
    if (!selected)
      throw new DomainError(
        "notifications_unavailable",
        "Push notifications are not configured",
        503,
      );
    const principal = c.get("principal");
    if (!principal.credential_hash)
      throw new DomainError("forbidden", "Client identity required", 403);
    if (
      "expirationTime" in body.subscription &&
      body.subscription.expirationTime !== null &&
      body.subscription.expirationTime <= Date.now()
    )
      throw new DomainError("subscription_expired", "Subscription expired", 400);
    const serialized = JSON.stringify(body.subscription);
    const hash = Buffer.from(
      await crypto.subtle.digest("SHA-256", new TextEncoder().encode(serialized)),
    ).toString("hex");
    const cipher = await seal({ subscription: serialized }, selected.encryptionKey);
    await sql.begin(async (tx) => {
      const rows = z
        .array(z.object({ id: z.uuid(), subscription_hash: z.string().nullable() }))
        .parse(
          await tx`SELECT id,subscription_hash FROM assistant.push_subscriptions WHERE workspace_id=${principal.workspace_id} AND credential_hash=${principal.credential_hash ?? ""} AND installation_id=${body.installation_id} FOR UPDATE`,
        );
      await tx`INSERT INTO assistant.push_subscriptions(workspace_id,credential_hash,session_hash,installation_id,subscription_cipher,subscription_hash,transport,enabled)
        VALUES(${principal.workspace_id},${principal.credential_hash ?? ""},${principal.session_hash ?? null},${body.installation_id},${cipher},${hash},${transport},true)
        ON CONFLICT(workspace_id,credential_hash,installation_id) DO UPDATE SET subscription_cipher=CASE WHEN assistant.push_subscriptions.subscription_hash IS NOT DISTINCT FROM excluded.subscription_hash THEN assistant.push_subscriptions.subscription_cipher ELSE excluded.subscription_cipher END,subscription_hash=excluded.subscription_hash,transport=excluded.transport,session_hash=excluded.session_hash,enabled=true,updated_at=now()`;
      for (const row of rows)
        if (row.subscription_hash !== hash)
          await tx`UPDATE assistant.notification_deliveries SET state='pending',lease_id=NULL,lease_until=NULL,next_attempt_at=now(),attempts=0 WHERE subscription_id=${row.id} AND state IN ('pending','leased')`;
    });
    return c.json({ enabled: true });
  });
  app.delete("/subscription/:installation", async (c) => {
    const principal = c.get("principal"),
      installation = z.uuid().parse(c.req.param("installation"));
    await sql.begin(async (tx) => {
      const rows =
        await tx`UPDATE assistant.push_subscriptions SET enabled=false,updated_at=now() WHERE workspace_id=${principal.workspace_id} AND credential_hash=${principal.credential_hash ?? ""} AND installation_id=${installation} AND session_hash IS NOT DISTINCT FROM ${principal.session_hash ?? null} RETURNING id`;
      for (const row of z.array(z.object({ id: z.uuid() })).parse(rows))
        await tx`UPDATE assistant.notification_deliveries SET state='suppressed',lease_id=NULL,lease_until=NULL WHERE subscription_id=${row.id} AND state IN ('pending','leased')`;
    });
    return c.json({ enabled: false });
  });
  return app;
}
