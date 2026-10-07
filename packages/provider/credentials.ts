import { chmod, mkdir, readFile, rename, stat, writeFile, realpath } from "node:fs/promises";
import { dirname } from "node:path";
import { withCredentialLock } from "./credential-lock.ts";
import { createRemoteJWKSet, jwtVerify } from "jose";
import ky from "ky";
import { z } from "zod";

export const Credential = z.object({
  issuer: z.literal("https://auth.openai.com"), subject: z.string().min(1), client_id: z.string().min(1),
  ext_agent_host_id: z.string().min(1), id_token: z.string(), access_token: z.string().min(1),
  refresh_token: z.string().min(1), expires_at: z.number(), scopes: z.array(z.string())
});
export const TokenResponse = z.object({ access_token: z.string().min(1), refresh_token: z.string().min(1), id_token: z.string().optional(), expires_in: z.number().positive(), scope: z.string(), token_type: z.literal("Bearer") });
export class CredentialError extends Error { constructor(readonly code: string) { super(code); this.name = "CredentialError"; } }
export async function atomicSecret(path: string, value: unknown): Promise<void> {
  await mkdir(dirname(path), { recursive: true, mode: 0o700 });
  const temp = `${path}.${crypto.randomUUID()}.tmp`;
  await writeFile(temp, JSON.stringify(value), { mode: 0o600, flag: "wx" });
  await chmod(temp, 0o600);
  await rename(temp, path);
}
const inflight = new Map<string, Promise<z.infer<typeof Credential>>>();
export async function readCredential(path: string): Promise<z.infer<typeof Credential>> {
  const canonical = await realpath(path);
  const existing = inflight.get(canonical);
  if (existing) return existing;
  const pending = refreshLocked(canonical);
  inflight.set(canonical, pending);
  try { return await pending; } finally { inflight.delete(canonical); }
}
async function load(path: string): Promise<z.infer<typeof Credential>> {
  const info = await stat(path);
  if ((info.mode & 0o077) !== 0) throw new CredentialError("credential_permissions_must_be_0600");
  const credential = Credential.parse(JSON.parse(await readFile(path, "utf8")));
  if (!credential.scopes.includes("chatgpt.tokens.use.direct")) throw new CredentialError("chatgpt_plan_scope_missing");
  return credential;
}
async function refreshLocked(path: string): Promise<z.infer<typeof Credential>> {
  const initial = await load(path);
  if (initial.expires_at > Date.now() + 60000) return initial;
  return withCredentialLock(path, async () => {
    const credential = await load(path);
    if (credential.expires_at > Date.now() + 60000) return credential;
    const refreshed = TokenResponse.parse(await ky.post("https://auth.openai.com/api/accounts/oauth/token", {
      body: new URLSearchParams({ grant_type: "refresh_token", client_id: credential.client_id, refresh_token: credential.refresh_token, resource: "https://api.openai.com/v1" }), retry: 0, timeout: 30000
    }).json());
    if (refreshed.id_token) {
      const { payload } = await jwtVerify(refreshed.id_token, createRemoteJWKSet(new URL("https://auth.openai.com/.well-known/jwks.json")), { issuer: credential.issuer, audience: credential.client_id, algorithms: ["RS256"], requiredClaims: ["exp", "sub"] });
      if (payload.sub !== credential.subject) throw new CredentialError("refresh_identity_mismatch");
    }
    const next = { ...credential, id_token: refreshed.id_token ?? credential.id_token, access_token: refreshed.access_token, refresh_token: refreshed.refresh_token, expires_at: Date.now() + refreshed.expires_in * 1000, scopes: refreshed.scope.split(" ") };
    if (!next.scopes.includes("chatgpt.tokens.use.direct")) throw new CredentialError("chatgpt_plan_scope_missing");
    await atomicSecret(path, next);
    return next;
  });
}
