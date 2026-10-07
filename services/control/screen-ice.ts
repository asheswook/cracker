import { Hono } from "hono";
import ky, { type KyInstance } from "ky";
import { z } from "zod";
import { DomainError, Id } from "../../packages/protocol";
import { daemonIceServers, IceConfiguration } from "../../packages/screen/ice";
import { IceServer } from "../../packages/screen/protocol";
import { type AppEnv, hashToken } from "./auth";
import type { Database } from "./db";

const TurnEnvironment = z.object({
  SCREEN_TURN_KEY_ID: z.string().min(1).max(256),
  SCREEN_TURN_API_TOKEN: z.string().min(1),
});
export type ScreenTurnConfig = z.infer<typeof TurnEnvironment>;
export type ScreenTurnSettings = {
  readonly SCREEN_TURN_KEY_ID: string | undefined;
  readonly SCREEN_TURN_API_TOKEN: string | undefined;
};
export function screenTurnConfig(env: unknown): ScreenTurnConfig | undefined {
  const optional = TurnEnvironment.partial().safeParse(env);
  if (optional.success && optional.data.SCREEN_TURN_KEY_ID === undefined && optional.data.SCREEN_TURN_API_TOKEN === undefined) return undefined;
  const config = TurnEnvironment.safeParse(env);
  if (!config.success) throw new DomainError("turn_configuration_invalid", "TURN configuration is incomplete", 503);
  return config.data;
}
const ProviderIce = z.object({ iceServers: z.array(z.object({
  urls: z.union([IceServer.shape.urls, z.array(IceServer.shape.urls).min(1).max(16)]),
  username: z.string().optional(), credential: z.string().optional(),
})).min(1).max(16) });
export async function generateScreenIce(config: ScreenTurnConfig, signal: AbortSignal, http: KyInstance = ky): Promise<IceConfiguration> {
  const issuedAt = Date.now();
  try {
    const body = await http.post(`https://rtc.live.cloudflare.com/v1/turn/keys/${encodeURIComponent(config.SCREEN_TURN_KEY_ID)}/credentials/generate-ice-servers`, {
      headers: { Authorization: `Bearer ${config.SCREEN_TURN_API_TOKEN}` },
      json: { ttl: 3600 }, signal, timeout: 8000, retry: 0,
    }).json();
    const parsed = ProviderIce.parse(body);
    const iceServers = parsed.iceServers.flatMap((server) => (typeof server.urls === "string" ? [server.urls] : server.urls).map((urls) => ({
      urls, ...(server.username ? { username: server.username } : {}), ...(server.credential ? { credential: server.credential } : {}),
    })));
    if (iceServers.some((server) => server.urls.startsWith("turn") && (!server.username || !server.credential)))
      throw new DomainError("turn_response_invalid", "TURN credentials unavailable", 503);
    const result = IceConfiguration.parse({ mode: "turn", iceServers, expiresAt: issuedAt + 3600000 });
    daemonIceServers(result);
    return result;
  } catch (error) {
    if (!(error instanceof Error)) throw error;
    // Provider errors may contain its URL, key identity, or response credentials.
    throw new DomainError("turn_credentials_unavailable", "TURN credentials unavailable", 503);
  }
}
export function screenIceRoutes(sql: Database, settings?: ScreenTurnSettings, generate = generateScreenIce): Hono<AppEnv> {
  const app = new Hono<AppEnv>();
  app.use("*", async (c, next) => { c.header("Cache-Control", "no-store"); await next(); });
  app.post("/vms/:id/screen/ice", async (c) => {
    const vm = Id.parse(c.req.param("id"));
    const principal = c.get("principal");
    const rows = await sql`SELECT id FROM assistant.vms WHERE id=${vm} AND workspace_id=${principal.workspace_id}`;
    if (!rows.length || (principal.role === "vm" && principal.vm_id !== vm))
      throw new DomainError("not_found", "VM not found", 404);
    const config = screenTurnConfig(settings ?? {});
    if (!config) return c.json({ mode: "direct", iceServers: [], expiresAt: null });
    // Separate namespace: issuance cannot consume or reset a sign-in bucket.
    const bucket = await hashToken(`screen-ice:${principal.workspace_id}:${vm}:${principal.role}`);
    const attempts = z.object({ attempts: z.number() }).parse((await sql`INSERT INTO assistant.session_login_limits(bucket_hash,attempts) VALUES(${bucket},1) ON CONFLICT(bucket_hash) DO UPDATE SET attempts=CASE WHEN session_login_limits.window_started_at<now()-interval '1 minute' THEN 1 ELSE session_login_limits.attempts+1 END,window_started_at=CASE WHEN session_login_limits.window_started_at<now()-interval '1 minute' THEN now() ELSE session_login_limits.window_started_at END RETURNING attempts`)[0]).attempts;
    if (attempts > 60) {
      c.header("Retry-After", "60");
      return c.json({ error: { code: "rate_limited", message: "Too many screen credential requests" } }, 429);
    }
    return c.json(await generate(config, c.req.raw.signal));
  });
  return app;
}
