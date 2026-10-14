import type { KyInstance } from "ky";
import { HTTPError } from "ky";
import { resolve } from "node:path";
import { z } from "zod";
import { SubscriptionClaim, SubscriptionResult, type SubscriptionCommand } from "../../packages/models/subscription-schema.ts";
import { SubscriptionProxy, SubscriptionProxyError } from "./subscription-proxy.ts";

export class SubscriptionAccountManager {
  private readonly sessions = new Map<string, { expires: number; location: "vm" | "local"; redirect: string | null }>();
  private pending: { request_id: string; result: SubscriptionResult | null } | undefined;
  private claimId = crypto.randomUUID();
  private operation: Promise<void> | undefined;
  private nextPoll = 0;
  private closed = false;
  constructor(private readonly http: KyInstance, private readonly proxy: SubscriptionProxy, private readonly changed: () => Promise<void>, private readonly openBrowser = async (url: string) => {
    const child = Bun.spawn([resolve("infra/linux/open-browser.sh"), url], { stdout: "ignore", stderr: "ignore" });
    const timer = setTimeout(() => child.kill(), 15000);
    try { if (await child.exited !== 0) throw new SubscriptionProxyError(); }
    finally { clearTimeout(timer); }
  }) {}
  tick(): void {
    if (this.closed || this.operation || Date.now() < this.nextPoll) return;
    this.nextPoll = Date.now() + 1500;
    this.operation = this.poll().catch(() => {
      // Optional proxy/control outages must not interrupt regular model runs.
      this.nextPoll = Date.now() + 10000;
    }).finally(() => { this.operation = undefined; });
  }
  async close(): Promise<void> { this.closed = true; await this.operation; }
  private async poll(): Promise<void> {
    for (const [state, session] of this.sessions) if (session.expires <= Date.now()) this.sessions.delete(state);
    if (!this.pending) {
      const { request } = z.object({ request: SubscriptionClaim.nullable() }).parse(await this.http.post("v1/daemon/subscription/claim", { json: { claim_id: this.claimId } }).json());
      if (!request) { this.claimId = crypto.randomUUID(); return; }
      let result: SubscriptionResult | null;
      try { result = SubscriptionResult.parse(await this.execute(request.command)); }
      catch { result = null; }
      this.pending = { request_id: request.request_id, result };
    }
    try { await this.http.post("v1/daemon/subscription/observed", { json: this.pending }); }
    catch (error) { if (!(error instanceof HTTPError && error.response.status === 409)) throw error; }
    this.pending = undefined;
    this.claimId = crypto.randomUUID();
  }
  private async execute(command: SubscriptionCommand): Promise<SubscriptionResult> {
    switch (command.action) {
      case "catalogue": {
        const [models, accounts] = await Promise.all([this.proxy.listModels(), this.proxy.listAccounts()]);
        await this.changed();
        return { action: "catalogue", models, accounts };
      }
      case "login": {
        if (this.sessions.size >= 8) throw new SubscriptionProxyError();
        const login = await this.proxy.startLogin(command.provider, command.location);
        this.sessions.set(login.state, { expires: Date.now() + 7 * 60000, location: command.location, redirect: new URL(login.url).searchParams.get("redirect_uri") });
        if (command.location === "vm") await this.openBrowser(login.url);
        return { action: "login", ...login };
      }
      case "status": {
        if (!this.sessions.has(command.state)) throw new SubscriptionProxyError();
        const status = await this.proxy.loginStatus(command.state);
        if (status === "ok") await this.changed();
        return { action: "status", status };
      }
      case "callback": {
        const session = this.sessions.get(command.state), url = new URL(command.redirect_url);
        if (!session || session.location !== "local" || url.searchParams.get("state") !== command.state) throw new SubscriptionProxyError();
        if (session.redirect) {
          const redirect = new URL(session.redirect);
          if (url.origin !== redirect.origin || url.pathname !== redirect.pathname) throw new SubscriptionProxyError();
        }
        await this.proxy.submitCallback(command.redirect_url);
        return { action: "callback", accepted: true };
      }
    }
  }
}
