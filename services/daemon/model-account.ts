import type { KyInstance } from "ky";
import { HTTPError } from "ky";
import { resolve } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { z } from "zod";
import { AccountObservation, ClaimedAccountRequest, LocalCallback } from "../../packages/models/account-schema.ts";
import { disconnectAccount, missingFile } from "../../packages/provider/account.ts";
import { CredentialError, readCredential } from "../../packages/provider/credentials.ts";
import { login } from "../../packages/provider/login.ts";

type Observation = z.infer<typeof AccountObservation>;
export type AccountOperations = {
  readonly inspect: () => Promise<Omit<Observation, "request_id">>;
  readonly connect: (signal: AbortSignal, request: z.infer<typeof ClaimedAccountRequest>) => Promise<void>;
  readonly disconnect: () => Promise<{ revoked: boolean }>;
};
export function accountOperations(path: string, http?: KyInstance): AccountOperations {
  return {
    async inspect() {
      try { await readCredential(path); return { state: "connected", error_code: null }; }
      catch (error) {
        if (missingFile(error)) return { state: "disconnected", error_code: null };
        if (error instanceof HTTPError && [400, 401].includes(error.response.status)) {
          const body = z.object({ error: z.string() }).safeParse(await error.response.clone().json().catch(() => null));
          if (body.success && body.data.error === "invalid_grant") return { state: "requires_login", error_code: null };
        }
        return { state: "unknown", error_code: "credential_error" };
      }
    },
    async connect(signal, request) {
      if (request.login_location === "local") {
        if (!http || !request.redirect_uri) throw new CredentialError("invalid_local_registration");
        const redirect = request.redirect_uri;
        await login(path, { signal, onAuthorize: async authorization_url => {
          await http.post("v1/daemon/model-account/authorization", { signal, json: { request_id: request.request_id, authorization_url } });
        }, callback: { redirect_uri: redirect, receive: async callbackSignal => {
          while (!callbackSignal.aborted) {
            const result = z.object({callback:LocalCallback.nullable()}).parse(await http.get("v1/daemon/model-account/callback", { signal: callbackSignal, searchParams: { request_id: request.request_id } }).json());
            if (result.callback) {
              const url = new URL(redirect);
              for (const [key,value] of Object.entries(result.callback)) if (value) url.searchParams.set(key,value);
              return url;
            }
            await delay(1000, undefined, { signal: callbackSignal });
          }
          throw new CredentialError("login_interrupted");
        } } });
        return;
      }
      await login(path, { signal, onAuthorize: async url => {
        const child = Bun.spawn([resolve("infra/linux/open-browser.sh"), url], { stdout: "ignore", stderr: "ignore" });
        const timer = setTimeout(() => child.kill(), 15000);
        try { if (await child.exited !== 0) throw new CredentialError("browser_unavailable"); }
        finally { clearTimeout(timer); }
      } });
    },
    disconnect: () => disconnectAccount(path),
  };
}
export class ModelAccountManager {
  private pending: Observation | undefined;
  private operation: Promise<void> | undefined;
  private readonly abort = new AbortController();
  private nextInspection = 0;
  private nextPoll = 0;
  constructor(private readonly http: KyInstance, private readonly operations: AccountOperations, private readonly changed: () => Promise<void>) {}
  get busy(): boolean { return Boolean(this.operation || this.pending?.request_id); }
  async tick(): Promise<void> {
    if (this.pending) {
      const report = this.pending;
      await this.changed();
      try { await this.http.post("v1/daemon/model-account/observed", { json: report }); }
      catch (error) {
        if (!(error instanceof HTTPError) || error.response.status !== 409) throw error;
        const result = z.object({error:z.object({code:z.literal("stale_configuration")})}).safeParse(await error.response.clone().json());
        if (!result.success) throw error;
      }
      this.pending = undefined;
    }
    if (this.operation || Date.now() < this.nextPoll) return;
    this.nextPoll = Date.now() + 3000;
    const { request } = z.object({ request: ClaimedAccountRequest.nullable() }).parse(await this.http.post("v1/daemon/model-account/claim").json());
    if (request) {
      this.operation = this.perform(request).finally(() => { this.operation = undefined; });
    } else if (Date.now() >= this.nextInspection) {
      this.nextInspection = Date.now() + 60000;
      this.operation = this.operations.inspect().then(result => { this.pending = { ...result, request_id: null }; }).finally(() => { this.operation = undefined; });
    }
  }
  private async perform(request: z.infer<typeof ClaimedAccountRequest>): Promise<void> {
    try {
      if (request.action === "connect") {
        await this.operations.connect(this.abort.signal, request);
        this.pending = { request_id: request.request_id, state: "connected", error_code: null };
      } else {
        const result = await this.operations.disconnect();
        this.pending = { request_id: request.request_id, state: "disconnected", error_code: result.revoked ? null : "revocation_unconfirmed" };
      }
    } catch (error) {
      const observed = await this.operations.inspect();
      const code = error instanceof CredentialError && ["login_timeout", "login_interrupted", "browser_unavailable"].includes(error.code) ? error.code : "login_failed";
      this.pending = AccountObservation.parse({ request_id: request.request_id, ...observed, error_code: code });
    }
    this.nextInspection = Date.now() + 60000;
  }
  async close(): Promise<void> { this.abort.abort(); await this.operation; }
}
