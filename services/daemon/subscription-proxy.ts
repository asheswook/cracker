import { readFile } from "node:fs/promises";
import { z } from "zod";
import { SubscriptionAuthorization, SubscriptionCallback, SubscriptionProvider, SubscriptionState } from "../../packages/models/subscription-schema.ts";

export const SubscriptionEnvironment = z.object({
  CLIPROXY_URL: z.url().default("http://127.0.0.1:8317").refine(value => {
    const url = new URL(value);
    return url.protocol === "http:" && ["127.0.0.1", "localhost", "[::1]"].includes(url.hostname) && !url.username && !url.password && !url.search && !url.hash && url.pathname === "/";
  }),
  CLIPROXY_CLIENT_KEY_FILE: z.string().min(1).optional(),
  CLIPROXY_MANAGEMENT_KEY_FILE: z.string().min(1).optional(),
});
type Settings = z.infer<typeof SubscriptionEnvironment>;
export class SubscriptionProxyError extends Error {
  constructor() { super("Subscription proxy request failed"); }
}
export class SubscriptionProxy {
  readonly baseURL: string;
  constructor(private readonly settings: Settings = SubscriptionEnvironment.parse(process.env), private readonly fetcher: typeof globalThis.fetch = globalThis.fetch) {
    this.baseURL = `${SubscriptionEnvironment.parse(settings).CLIPROXY_URL.replace(/\/$/, "")}/v1`;
  }
  async clientKey(): Promise<string> { return this.key(this.settings.CLIPROXY_CLIENT_KEY_FILE); }
  private async key(path: string | undefined): Promise<string> {
    try { if (!path) throw new SubscriptionProxyError(); return z.string().trim().min(1).parse(await readFile(path, "utf8")); }
    catch { throw new SubscriptionProxyError(); }
  }
  private async request(path: string, management: boolean, body?: unknown): Promise<unknown> {
    try {
      const key = await this.key(management ? this.settings.CLIPROXY_MANAGEMENT_KEY_FILE : this.settings.CLIPROXY_CLIENT_KEY_FILE);
      const response = await this.fetcher(`${this.settings.CLIPROXY_URL.replace(/\/$/, "")}${path}`, {
        method: body === undefined ? "GET" : "POST", redirect: "error", signal: AbortSignal.timeout(10000),
        headers: { Authorization: `Bearer ${key}`, "Content-Type": "application/json" },
        ...(body === undefined ? {} : { body: JSON.stringify(body) }),
      });
      if (!response.ok) throw new SubscriptionProxyError();
      return await response.json();
    } catch { throw new SubscriptionProxyError(); }
  }
  async listModels() {
    const result = z.object({ data: z.array(z.object({ id: z.string().min(1), owned_by: z.string().default("") }).passthrough()) }).passthrough().parse(await this.request("/v1/models", false));
    return result.data.map(({ id, owned_by }) => ({ id, owned_by }));
  }
  async startLogin(provider: z.infer<typeof SubscriptionProvider>, location: "vm" | "local" = "local") {
    // v8 starts Claude/Codex localhost callback listeners only for web-UI logins.
    const result = z.object({ url: SubscriptionAuthorization, state: SubscriptionState }).passthrough().parse(await this.request(`/v8/management/oauth/auth-url?provider=${SubscriptionProvider.parse(provider)}${location === "vm" ? "&is_webui=true" : ""}`, true));
    return { url: result.url, state: result.state };
  }
  async loginStatus(state: string) {
    return z.object({ status: z.enum(["wait", "ok", "error"]) }).passthrough().parse(await this.request(`/v8/management/oauth/status?state=${encodeURIComponent(SubscriptionState.parse(state))}`, true)).status;
  }
  async submitCallback(redirect_url: string): Promise<void> {
    z.object({ status: z.literal("ok") }).passthrough().parse(await this.request("/v8/management/oauth/callback", true, { redirect_url: SubscriptionCallback.parse(redirect_url) }));
  }
  async listAccounts() {
    const entry = z.object({ provider: z.string().optional(), type: z.string().optional(), label: z.string().optional(), email: z.string().optional(), status: z.string().optional() }).passthrough();
    const result = z.object({ files: z.array(entry) }).passthrough().parse(await this.request("/v8/management/credentials", true));
    return result.files.map(account => ({ provider: account.provider || account.type || "unknown", label: account.label || account.email || "", status: account.status || "unknown" }));
  }
}
