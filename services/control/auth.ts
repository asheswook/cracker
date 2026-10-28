import { parse } from "hono/utils/cookie";
import { z } from "zod";
import { DomainError } from "../../packages/protocol";
import type { Query } from "./db";
export const Principal = z.object({
  workspace_id: z.uuid(), role: z.enum(["client", "vm"]), vm_id: z.uuid().nullable(), credential_hash: z.string().optional(), session_hash: z.string().optional(), daemon_session_id:z.uuid().optional()
});
export type Principal = z.infer<typeof Principal>;
export type AppEnv = { Variables: { principal: Principal; attention_diagnostics?: import('../../packages/attention/brief-diagnostics').BriefDiagnostics; attention_started_at?: number } };
export const SESSION_DAYS = 30;
const SESSION_LIFETIME = `${SESSION_DAYS} days`, SESSION_RENEW_BELOW = `${SESSION_DAYS / 2} days`;
export async function hashToken(token: string): Promise<string> {
  const bytes = new Uint8Array(await crypto.subtle.digest("SHA-256", new TextEncoder().encode(token)));
  return Array.from(bytes, byte => byte.toString(16).padStart(2, "0")).join("");
}
export async function authenticate(sql: Query, authorization: string | undefined, cookie?: string): Promise<Principal> {
  if (authorization !== undefined) {
    if (!authorization.startsWith("Bearer ") || authorization.length < 20) throw new DomainError("unauthorized", "Valid bearer credential required", 401);
    const rows = await sql`SELECT workspace_id,role,vm_id,token_hash AS credential_hash FROM assistant.credentials WHERE token_hash=${await hashToken(authorization.slice(7))} AND revoked_at IS NULL`;
    if (!rows[0]) throw new DomainError("unauthorized", "Invalid or revoked credential", 401);
    return Principal.parse(rows[0]);
  }
  const session = parse(cookie ?? "")["assistant_session"];
  if (!session || session.length < 32) throw new DomainError("unauthorized", "Valid session or bearer credential required", 401);
  const hash = await hashToken(session);
  const rows = await sql`SELECT c.workspace_id,c.role,c.vm_id,c.token_hash AS credential_hash,s.token_hash AS session_hash,s.expires_at<now()+${SESSION_RENEW_BELOW}::interval AS renew FROM assistant.browser_sessions s JOIN assistant.credentials c ON c.token_hash=s.credential_hash WHERE s.token_hash=${hash} AND s.revoked_at IS NULL AND s.expires_at>now() AND c.revoked_at IS NULL AND c.role='client'`;
  if (!rows[0]) throw new DomainError("unauthorized", "Invalid or expired session", 401);
  if (rows[0]["renew"]) await sql`UPDATE assistant.browser_sessions SET expires_at=now()+${SESSION_LIFETIME}::interval WHERE token_hash=${hash} AND revoked_at IS NULL`;
  return Principal.parse(rows[0]);
}
export function requireOrigin(request: Request, allowedOrigins: readonly string[] = []): void {
  const origin = request.headers.get("origin");
  if (!origin || (origin !== new URL(request.url).origin && !allowedOrigins.includes(origin))) throw new DomainError("csrf_rejected", "Same-origin request required", 403);
}
