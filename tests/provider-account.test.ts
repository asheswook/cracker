import { expect, test } from "bun:test";
import { mkdtemp, readFile, rm, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { atomicSecret } from "../packages/provider/credentials.ts";
import { disconnectAccount, readRegistration } from "../packages/provider/account.ts";
import { login } from "../packages/provider/login.ts";

const synthetic = { issuer: "https://auth.openai.com", subject: "test-subject", client_id: "test-client", ext_agent_host_id: "test-host", id_token: "fixture-id", access_token: "fixture-access", refresh_token: "fixture-refresh", expires_at: 0, scopes: ["chatgpt.tokens.use.direct"] };
for (const remote of [true, false]) test(`disconnect removes tokens and preserves registration; remote revocation ${remote}`, async () => {
  const dir = await mkdtemp(join(tmpdir(), "account-test-")), path = join(dir, "tokens.json");
  try {
    await atomicSecret(path, synthetic);
    await atomicSecret(`${path}.host`, synthetic.ext_agent_host_id);
    const calls: string[] = [];
    const request = Object.assign(async (input: string | URL | Request, init?: RequestInit) => {
      calls.push(String(input));
      if (String(input).endsWith("openid-configuration")) return Response.json({ revocation_endpoint: "https://auth.openai.com/revoke" });
      expect(init?.body).toBeInstanceOf(URLSearchParams);
      expect(String(init?.body)).toContain("token_type_hint=refresh_token");
      return new Response(null, { status: remote ? 200 : 503 });
    }, { preconnect: fetch.preconnect });
    expect(await disconnectAccount(path, request)).toEqual({ revoked: remote });
    expect(await Bun.file(path).exists()).toBe(false);
    const registration = await readRegistration(path);
    expect(registration?.client_id).toBe(synthetic.client_id);
    expect(await readFile(`${path}.registration`, "utf8")).not.toContain("fixture-");
    expect((await stat(`${path}.registration`)).mode & 0o777).toBe(0o600);
    expect(JSON.parse(await readFile(`${path}.host`, "utf8"))).toBe(synthetic.ext_agent_host_id);
    expect(calls.length).toBe(remote ? 2 : 4);
    expect(await disconnectAccount(path, request)).toEqual({ revoked: true });
    const abort = new AbortController(); let callback = "";
    const pending = login(path, { signal: abort.signal, onAuthorize: async url => {
      const authorize = new URL(url);
      expect(authorize.searchParams.get("client_id")).toBe(synthetic.client_id);
      expect(authorize.searchParams.has("id_token_hint")).toBe(false);
      callback = authorize.searchParams.get("redirect_uri") ?? "";
      abort.abort();
    } });
    await expect(pending).rejects.toThrow("login_interrupted");
    await expect(fetch(callback)).rejects.toThrow();
  } finally { await rm(dir, { recursive: true, force: true }); }
});
