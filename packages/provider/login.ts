import { readFile } from "node:fs/promises";
import { randomBytes, createHash } from "node:crypto";
import { createRemoteJWKSet, jwtVerify } from "jose";
import ky from "ky";
import { z } from "zod";
import { atomicSecret, Credential, CredentialError, TokenResponse } from "./credentials.ts";
import { readRegistration, saveRegistration } from "./account.ts";
import { withCredentialLock } from "./credential-lock.ts";

export async function login(path: string, options: { readonly onAuthorize?: (url: string) => Promise<void>; readonly signal?: AbortSignal; readonly callback?: { readonly redirect_uri: string; readonly receive: (signal: AbortSignal) => Promise<URL> } } = {}): Promise<void> {
  options.signal?.throwIfAborted();
  const hostPath = `${path}.host`;
  let host: string;
  try { host = z.string().min(1).parse(JSON.parse(await readFile(hostPath, "utf8"))); }
  catch (error) {
    if (!(error instanceof Error && "code" in error && error.code === "ENOENT")) throw error;
    host = `urn:uuid:${crypto.randomUUID()}`; await atomicSecret(hostPath, host);
  }
  let previous: z.infer<typeof Credential> | undefined;
  try { previous = Credential.parse(JSON.parse(await readFile(path, "utf8"))); }
  catch (error) { if (!(error instanceof Error && "code" in error && error.code === "ENOENT")) throw error; }
  const registration = previous ?? await readRegistration(path);
  const state = randomBytes(32).toString("base64url");
  const nonce = randomBytes(32).toString("base64url");
  const verifier = randomBytes(48).toString("base64url");
  const done = Promise.withResolvers<URL>();
  const server = options.callback ? undefined : Bun.serve({ hostname: "127.0.0.1", port: 0, fetch(request) {
    const url = new URL(request.url);
    if (url.pathname !== "/auth/callback" || url.searchParams.get("state") !== state) return new Response("Invalid callback", { status: 400 });
    done.resolve(url); return new Response("Sign-in received. You may close this window.");
  } });
  const redirect = options.callback?.redirect_uri ?? `http://127.0.0.1:${server?.port}/auth/callback`;
  const authorize = new URL("https://auth.openai.com/api/accounts/authorize");
  authorize.search = new URLSearchParams({ client_id: registration?.client_id ?? "dynamic_agent_client", ext_agent_host_id: host,
    response_type: "code", redirect_uri: redirect, scope: "openid profile email offline_access resource.invoke chatgpt.tokens.use.direct",
    resource: "https://api.openai.com/v1", state, nonce, code_challenge_method: "S256", code_challenge: createHash("sha256").update(verifier).digest("base64url") }).toString();
  if (previous && !options.callback) authorize.searchParams.set("id_token_hint", previous.id_token);
  else authorize.searchParams.set("agent_name_hint", "Autonomous Assistant");
  const lifecycle = new AbortController();
  const timer = setTimeout(() => { lifecycle.abort(); done.reject(new CredentialError("login_timeout")); }, 300000);
  const abort = () => { lifecycle.abort(); done.reject(new CredentialError("login_interrupted")); };
  options.signal?.addEventListener("abort", abort, { once: true });
  void done.promise.catch(() => {});
  try {
    options.signal?.throwIfAborted();
    if (options.onAuthorize) await options.onAuthorize(authorize.href);
    else console.log(`Continue with ChatGPT: ${authorize.href}`);
    const callback = options.callback ? await Promise.race([done.promise, options.callback.receive(lifecycle.signal)]) : await done.promise;
    if (callback.searchParams.get("state") !== state) throw new CredentialError("invalid_callback_state");
    if (callback.searchParams.has("error")) throw new CredentialError("login_denied");
    const clientId = callback.searchParams.get("client_id") ?? registration?.client_id;
    const code = callback.searchParams.get("code");
    if (!clientId || clientId === "dynamic_agent_client" || !code || (registration && clientId !== registration.client_id)) throw new CredentialError("invalid_registration");
    const tokens = TokenResponse.parse(await ky.post("https://auth.openai.com/api/accounts/oauth/token", { retry: 0, timeout: 30000, signal: lifecycle.signal,
      body: new URLSearchParams({ grant_type: "authorization_code", client_id: clientId, code, code_verifier: verifier, redirect_uri: redirect, resource: "https://api.openai.com/v1" }) }).json());
    if (!tokens.id_token) throw new CredentialError("missing_identity");
    const { payload } = await jwtVerify(tokens.id_token, createRemoteJWKSet(new URL("https://auth.openai.com/.well-known/jwks.json")), { issuer: "https://auth.openai.com", audience: clientId, algorithms: ["RS256"], requiredClaims: ["exp", "sub", "nonce"] });
    if (payload["nonce"] !== nonce || !payload.sub || (registration && registration.subject !== payload.sub)) throw new CredentialError("identity_mismatch");
    const scopes = tokens.scope.split(" ");
    const subject = payload.sub;
    if (!scopes.includes("chatgpt.tokens.use.direct")) throw new CredentialError("chatgpt_plan_scope_missing");
    await withCredentialLock(path, async () => {
      options.signal?.throwIfAborted();
      await atomicSecret(path, Credential.parse({ issuer: "https://auth.openai.com", subject: payload.sub, client_id: clientId, ext_agent_host_id: host, id_token: tokens.id_token, access_token: tokens.access_token, refresh_token: tokens.refresh_token, expires_at: Date.now() + tokens.expires_in * 1000, scopes }));
      await saveRegistration(path, { issuer: "https://auth.openai.com", subject, client_id: clientId, ext_agent_host_id: host });
    });
  } finally { clearTimeout(timer); lifecycle.abort(); options.signal?.removeEventListener("abort", abort); await server?.stop(true); }
}
if (import.meta.main) {
  try { await login(z.string().min(1).parse(process.env["CHATGPT_TOKEN_FILE"])); }
  catch (error) { if (!(error instanceof Error)) throw error; console.error(JSON.stringify({ event: "login.failed", type: error.name })); process.exitCode = 1; }
}
