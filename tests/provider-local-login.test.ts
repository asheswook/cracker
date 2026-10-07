import { expect, test } from "bun:test";
import { generateKeyPair, exportJWK, SignJWT } from "jose";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { login } from "../packages/provider/login.ts";
import { Credential } from "../packages/provider/credentials.ts";

for (const valid of [true, false]) test(`local loopback login validates the callback before exchanging; valid=${valid}`, async () => {
  // Given a local receiver, real RSA-signed ID token and HTTP token/JWKS fixtures.
  const dir = await mkdtemp(join(tmpdir(), "local-model-login-")), path = join(dir, "credential.json");
  const { privateKey, publicKey } = await generateKeyPair("RS256"), jwk = { ...await exportJWK(publicKey), kid: "fixture-key", alg: "RS256" };
  const redirect = "http://127.0.0.1:43297/auth/callback";
  let authorize: URL | undefined, exchanges = 0;
  const original = globalThis.fetch;
  globalThis.fetch = Object.assign(async (input: string | URL | Request, init?: RequestInit) => {
    const request = new Request(input, init);
    if (request.url.endsWith("/.well-known/jwks.json")) return Response.json({ keys: [jwk] });
    expect(request.url).toBe("https://auth.openai.com/api/accounts/oauth/token"); exchanges++;
    const body = new URLSearchParams(await request.text());
    expect(body.get("redirect_uri")).toBe(redirect);
    expect(body.get("client_id")).toBe("fixture-issued-client");
    expect(body.get("code_verifier")?.length).toBeGreaterThan(40);
    const id_token = await new SignJWT({ nonce: authorize?.searchParams.get("nonce") }).setProtectedHeader({ alg: "RS256", kid: "fixture-key" }).setIssuer("https://auth.openai.com").setSubject("fixture-user").setAudience("fixture-issued-client").setExpirationTime("5m").sign(privateKey);
    return Response.json({ access_token: "synthetic-access", refresh_token: "synthetic-refresh", id_token, token_type: "Bearer", expires_in: 3600, scope: "openid chatgpt.tokens.use.direct" });
  }, { preconnect: original.preconnect });
  try {
    // When the same provider enrolls through a callback on the user's computer.
    const attempt = login(path, { onAuthorize: async value => {
      authorize = new URL(value); expect(authorize.searchParams.get("redirect_uri")).toBe(redirect);
      expect(authorize.searchParams.has("id_token_hint")).toBe(false);
    }, callback: { redirect_uri: redirect, receive: async () => {
      const callback = new URL(redirect); callback.search = new URLSearchParams({ state: valid ? authorize?.searchParams.get("state") ?? "missing" : "wrong-state", code: "synthetic-code", client_id: "fixture-issued-client" }).toString(); return callback;
    } } });
    if (!valid) { await expect(attempt).rejects.toThrow("invalid_callback_state"); expect(exchanges).toBe(0); expect(await Bun.file(path).exists()).toBe(false); }
    else { await attempt; expect(exchanges).toBe(1); expect(Credential.parse(await Bun.file(path).json()).subject).toBe("fixture-user"); }
  } finally { globalThis.fetch = original; await rm(dir, { recursive: true }); }
});
