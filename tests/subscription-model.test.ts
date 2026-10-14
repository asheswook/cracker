import { expect, test } from "bun:test";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import ky from "ky";
import { ModelDefaults, ModelSelection } from "../packages/models/schema.ts";
import { SubscriptionCallback } from "../packages/models/subscription-schema.ts";
import { OpenAIProvider } from "../packages/provider/index.ts";
import { ModelResolver } from "../services/daemon/model-resolver.ts";
import { SubscriptionEnvironment, SubscriptionProxy } from "../services/daemon/subscription-proxy.ts";

test("subscription accepts catalogue IDs and nullable reasoning without relaxing existing providers", () => {
  for (const model of ["gemini-2.5-pro", "kimi-k2", "custom:model.v1", "claude-sonnet-5-5"]) {
    for (const reasoning_effort of [null, "high"] as const)
      expect(ModelSelection.safeParse({ provider: "subscription", model, reasoning_effort }).success).toBe(true);
    expect(ModelSelection.safeParse({ provider: "openai", model, reasoning_effort: null }).success).toBe(false);
    expect(ModelSelection.safeParse({ provider: "chatgpt", model, reasoning_effort: null }).success).toBe(false);
  }
  expect(ModelSelection.safeParse({ provider: "subscription", model: "bad/model", reasoning_effort: null }).success).toBe(false);
  expect(ModelSelection.safeParse({ provider: "anthropic", model: "claude-sonnet-5-5", reasoning_effort: "high" }).success).toBe(false);
  expect(ModelSelection.safeParse({ provider: "openai", model: "gpt-6-astra", reasoning_effort: "low" }).success).toBe(true);
  expect(ModelDefaults.safeParse({ selection: { provider: "subscription", model: "kimi-k2", reasoning_effort: null }, available: ["chatgpt", "openai", "anthropic", "subscription"] }).success).toBe(true);
});

async function files() {
  const directory = await mkdtemp(join(tmpdir(), "subscription-"));
  const client = join(directory, "client-key"), management = join(directory, "management-key");
  await writeFile(client, "client-fixture\n", { mode: 0o600 });
  await writeFile(management, "management-fixture\n", { mode: 0o600 });
  return { directory, settings: SubscriptionEnvironment.parse({ CLIPROXY_CLIENT_KEY_FILE: client, CLIPROXY_MANAGEMENT_KEY_FILE: management }) };
}

test("proxy parses live models, OAuth and credential metadata without exposing extra fields", async () => {
  const fixture = await files();
  let body: unknown = { data: [], object: "list" };
  const calls: { url: string; init: RequestInit | undefined }[] = [];
  const fetcher: typeof fetch = Object.assign(async (input: string | URL | Request, init?: RequestInit) => {
    calls.push({ url: String(input), init });
    return Response.json(body);
  }, { preconnect: fetch.preconnect });
  const proxy = new SubscriptionProxy(fixture.settings, fetcher);
  try {
    expect(await proxy.listModels()).toEqual([]);
    body = { data: [{ id: "kimi-k2", owned_by: "moonshot", ignored: "secret" }], object: "list" };
    expect(await proxy.listModels()).toEqual([{ id: "kimi-k2", owned_by: "moonshot" }]);
    body = { status: "ok", state: "state-fixture", url: "https://claude.ai/oauth/authorize?state=state-fixture", ignored: "secret" };
    expect(await proxy.startLogin("claude")).toEqual({ state: "state-fixture", url: "https://claude.ai/oauth/authorize?state=state-fixture" });
    for (const status of ["wait", "ok", "error"] as const) {
      body = { status, error: "private provider error" };
      expect(await proxy.loginStatus("state-fixture")).toBe(status);
    }
    body = { status: "ok" };
    await proxy.submitCallback("http://localhost:54545/callback?state=state-fixture&code=code-fixture");
    body = { files: [{ provider: "claude", label: "Primary", email: "person@example.com", status: "active", access_token: "never-return", id_token: { claim: "private" } }, { type: "codex", email: "other@example.com" }] };
    expect(await proxy.listAccounts()).toEqual([{ provider: "claude", label: "Primary", status: "active" }, { provider: "codex", label: "other@example.com", status: "unknown" }]);
    expect(calls[0]?.url).toBe("http://127.0.0.1:8317/v1/models");
    expect(new Headers(calls[0]?.init?.headers).get("Authorization")).toBe("Bearer client-fixture");
    expect(calls[2]?.url).toEndWith("/v8/management/oauth/auth-url?provider=claude");
    expect(new Headers(calls[2]?.init?.headers).get("Authorization")).toBe("Bearer management-fixture");
    expect(calls.every(call => call.init?.signal instanceof AbortSignal && call.init.redirect === "error")).toBe(true);
    expect(calls[6]?.init?.body).toBe(JSON.stringify({ redirect_url: "http://localhost:54545/callback?state=state-fixture&code=code-fixture" }));
    body = { status: "ok", state: "vm-state", url: "https://auth.openai.com/oauth/authorize?state=vm-state" };
    await proxy.startLogin("codex", "vm");
    expect(calls.at(-1)?.url).toEndWith("/v8/management/oauth/auth-url?provider=codex&is_webui=true");
    body = { status: "unexpected" };
    await expect(proxy.loginStatus("state-fixture")).rejects.toThrow();
    body = { data: [{ id: 42 }] };
    await expect(proxy.listModels()).rejects.toThrow();
  } finally { await rm(fixture.directory, { recursive: true, force: true }); }
});

test("callback rejects remote targets and OAuth tokens", () => {
  expect(SubscriptionCallback.safeParse("http://localhost:1455/auth/callback?state=s&code=c").success).toBe(true);
  for (const url of ["https://evil.example/cb?state=s&code=c", "http://localhost/cb?state=s&code=c&access_token=secret", "http://localhost/cb?state=s&code=c#access_token=secret", "http://localhost/cb?state=s&state=other&code=c"])
    expect(SubscriptionCallback.safeParse(url).success).toBe(false);
});

test("resolver routes subscription to proxy Responses over HTTP and advertises only nonempty models", async () => {
  const fixture = await files();
  const selection = { provider: "subscription", model: "gemini-custom", reasoning_effort: "high" } as const;
  let count = 0, catalogue = true;
  const advertised: unknown[] = [];
  const server = Bun.serve({ hostname: "127.0.0.1", port: 0, async fetch(request) {
    const url = new URL(request.url);
    if (url.pathname === "/v1/models") return Response.json({ data: catalogue ? [{ id: selection.model, owned_by: "google" }] : [] });
    if (url.pathname === "/v1/daemon/model-settings/defaults") { advertised.push(await request.json()); return Response.json({ accepted: true }); }
    if (url.pathname === "/v1/daemon/model-settings/current") return Response.json({ binding: { revision_id: null, selection }, api_key: "must-not-use-control-key" });
    if (url.pathname === "/v1/responses") {
      count++;
      expect(request.method).toBe("POST");
      expect(request.headers.get("authorization")).toBe("Bearer client-fixture");
      expect(request.headers.get("upgrade")).toBeNull();
      expect(await request.json()).toMatchObject({ model: selection.model, reasoning: { effort: "high" }, stream: true });
      return new Response(`data: ${JSON.stringify({ type: "response.completed", response: { id: "response-fixture", output: [{ type: "message", role: "assistant", content: [{ type: "output_text", text: "ok" }] }] } })}\n\n`, { headers: { "Content-Type": "text/event-stream" } });
    }
    return new Response("Unexpected path", { status: 404 });
  } });
  try {
    const proxy = new SubscriptionProxy({ ...fixture.settings, CLIPROXY_URL: server.url.origin });
    const defaultConfig = { mode: "api", model: "gpt-6-astra", apiKey: "default-fixture" } as const;
    const resolver = new ModelResolver({ defaultConfig, defaultProvider: new OpenAIProvider(defaultConfig), subscription: proxy, http: ky.create({ prefixUrl: server.url, retry: 0 }) });
    const lease = await resolver.current(new AbortController().signal);
    expect(lease.provider.standaloneCompaction).toBe(false);
    expect((await lease.provider.respond([], [], new AbortController().signal)).output_text).toBe("ok");
    await expect(lease.provider.compact?.([], new AbortController().signal)).rejects.toThrow("standalone compaction");
    await lease.release();
    // Even a caller requesting websocket cannot put proxy mode on a socket.
    const direct = new OpenAIProvider({ mode: "proxy", transport: "websocket", baseURL: proxy.baseURL, apiKey: await proxy.clientKey(), model: selection.model, reasoningEffort: "high" });
    await direct.respond([], [], new AbortController().signal); direct.close();
    expect(count).toBe(2);
    await resolver.advertise(); catalogue = false; await resolver.advertise();
    expect(advertised[0]).toMatchObject({ available: ["openai", "subscription"] });
    expect(advertised[1]).toMatchObject({ available: ["openai"] });
  } finally { await server.stop(true); await rm(fixture.directory, { recursive: true, force: true }); }
});
