import { Hono } from "hono";
import { deleteCookie, getCookie, setCookie } from "hono/cookie";
import { z } from "zod";
import { DomainError } from "../../../packages/protocol";
import { authenticate, hashToken, SESSION_DAYS, type AppEnv } from "../auth";
import type { Database } from "../db";
export function sessionRoutes(sql: Database): Hono<AppEnv> {
  const app = new Hono<AppEnv>();
  app.post("/", async c => {
    const bucket = await hashToken(c.req.header("cf-connecting-ip") ?? "local-shared-login-bucket");
    const attempts = z.object({ attempts: z.number() }).parse((await sql`INSERT INTO assistant.session_login_limits(bucket_hash,attempts) VALUES(${bucket},1) ON CONFLICT(bucket_hash) DO UPDATE SET attempts=CASE WHEN session_login_limits.window_started_at<now()-interval '1 minute' THEN 1 ELSE session_login_limits.attempts+1 END,window_started_at=CASE WHEN session_login_limits.window_started_at<now()-interval '1 minute' THEN now() ELSE session_login_limits.window_started_at END RETURNING attempts`)[0]).attempts;
    if (attempts > 10) { c.header("Retry-After", "60"); return c.json({ error: { code: "rate_limited", message: "Too many sign-in attempts" } }, 429); }
    const { token } = z.object({ token: z.string().min(32).max(4096) }).strict().parse(await c.req.json());
    const principal = await authenticate(sql, `Bearer ${token}`);
    if (principal.role !== "client" || !principal.credential_hash) throw new DomainError("forbidden", "Client credential required", 403);
    const credentialHash = principal.credential_hash;
    const value = Array.from(crypto.getRandomValues(new Uint8Array(32)), b => b.toString(16).padStart(2, "0")).join("");
    const previous = getCookie(c, "assistant_session");
    await sql.begin(async tx => {
      await tx`INSERT INTO assistant.browser_sessions(token_hash,credential_hash,expires_at) VALUES(${await hashToken(value)},${credentialHash},now()+${`${SESSION_DAYS} days`}::interval)`;
      if (previous) {
        const old = await hashToken(previous);
        await tx`UPDATE assistant.browser_sessions SET revoked_at=now() WHERE token_hash=${old}`;
        await tx`UPDATE assistant.push_subscriptions SET session_hash=${await hashToken(value)},updated_at=now() WHERE session_hash=${old} AND credential_hash=${credentialHash}`;
      }
    });
    setCookie(c, "assistant_session", value, { path: "/v1", httpOnly: true, secure: new URL(c.req.url).protocol === "https:", sameSite: "Strict", maxAge: SESSION_DAYS * 24 * 60 * 60 });
    return c.json({ workspace_id: principal.workspace_id });
  });
  app.get("/", c => {
    const value = getCookie(c, "assistant_session");
    if (value && c.get("principal").session_hash) setCookie(c, "assistant_session", value, { path: "/v1", httpOnly: true, secure: new URL(c.req.url).protocol === "https:", sameSite: "Strict", maxAge: SESSION_DAYS * 24 * 60 * 60 });
    return c.json({ workspace_id: c.get("principal").workspace_id });
  });
  app.delete("/", async c => {
    const value = getCookie(c, "assistant_session");
    if (value) {
      const hash = await hashToken(value);
      await sql.begin(async tx => {
        await tx`UPDATE assistant.browser_sessions SET revoked_at=now() WHERE token_hash=${hash}`;
        await tx`UPDATE assistant.push_subscriptions SET enabled=false,updated_at=now() WHERE session_hash=${hash}`;
      });
    }
    deleteCookie(c, "assistant_session", { path: "/v1", httpOnly: true, secure: new URL(c.req.url).protocol === "https:", sameSite: "Strict" });
    return c.json({ logged_out: true });
  });
  return app;
}
