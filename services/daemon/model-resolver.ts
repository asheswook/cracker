import type { KyInstance } from "ky";
import { existsSync } from "node:fs";
import { ModelAccess, type ModelBinding, type ModelSelection } from "../../packages/models/schema.ts";
import { OpenAIProvider, ProviderError, type Provider, type ProviderConfig } from "../../packages/provider/index.ts";
import { AnthropicProvider } from "../../packages/provider/anthropic.ts";
import type { ProviderRetryObserver } from '../../packages/provider/retry.ts';
import { SubscriptionProxy } from "./subscription-proxy.ts";
import { auxiliarySelection } from "./auxiliary-model.ts";

export type ProviderLease = { readonly provider: Provider; release(): Promise<void> };
export type AuxiliaryLease = ProviderLease & { readonly model: string };
export interface RunModelResolver {
  forRun(runId: string, signal: AbortSignal, expected?: ModelBinding): Promise<ProviderLease>;
  current(signal: AbortSignal): Promise<ProviderLease>;
  /** Small same-family model for the knowledge tree, using the credentials of the run's model (or the default when no run). */
  auxiliary?(signal: AbortSignal, runId?: string): Promise<AuxiliaryLease>;
}
export type ModelConnections = {
  readonly defaultProvider: Provider;
  readonly defaultConfig: ProviderConfig;
  readonly anthropicKey?: string;
  readonly http: KyInstance;
  readonly subscription?: SubscriptionProxy;
};
export class ModelResolver implements RunModelResolver {
  private readonly subscription: SubscriptionProxy;
  constructor(private readonly connections: ModelConnections) { this.subscription = connections.subscription ?? new SubscriptionProxy(); }
  private defaultSelection(): ModelSelection {
    const config = this.connections.defaultConfig;
    return { provider: config.mode === "proxy" ? "subscription" : config.mode === "chatgpt" ? "chatgpt" : "openai", model: config.model, reasoning_effort: config.reasoningEffort ?? null };
  }
  async auxiliary(signal: AbortSignal, runId?: string): Promise<AuxiliaryLease> {
    const access = ModelAccess.parse(await this.connections.http.get(runId ? `v1/daemon/model-settings/runs/${runId}` : "v1/daemon/model-settings/current", { signal }).json());
    const selection = auxiliarySelection(access.binding?.selection ?? this.defaultSelection());
    const lease = await this.open({ binding: { revision_id: access.binding?.revision_id ?? null, selection }, api_key: access.api_key }, runId);
    return { ...lease, model: selection.model };
  }
  async advertise(): Promise<void> {
    const config = this.connections.defaultConfig;
    const selection = this.defaultSelection();
    const available: ModelSelection["provider"][] = [];
    if (config.tokenFile && existsSync(config.tokenFile)) available.push("chatgpt");
    if (config.apiKey) available.push("openai");
    if (this.connections.anthropicKey) available.push("anthropic");
    const catalogue = await this.subscription.listModels().catch(() => []);
    if (catalogue.length) available.push("subscription");
    await this.connections.http.post("v1/daemon/model-settings/defaults", { json: { selection, available } });
  }
  async forRun(runId: string, signal: AbortSignal, expected?: ModelBinding): Promise<ProviderLease> {
    const access = ModelAccess.parse(await this.connections.http.get(`v1/daemon/model-settings/runs/${runId}`, { signal }).json());
    if (expected && JSON.stringify(access.binding) !== JSON.stringify(expected))
      throw new ProviderError("configuration", "Pinned model configuration changed");
    return this.open(access,runId);
  }
  async current(signal: AbortSignal): Promise<ProviderLease> {
    return this.open(ModelAccess.parse(await this.connections.http.get("v1/daemon/model-settings/current", { signal }).json()));
  }
  private async open(access: ModelAccess, runId?: string): Promise<ProviderLease> {
    if (!access.binding) return { provider: this.connections.defaultProvider, release: async () => {} };
    const config = this.connections.defaultConfig, selection = access.binding.selection;
    const onRetry:ProviderRetryObserver=decision=>console.warn(JSON.stringify({event:'provider.retry',...(runId?{run_id:runId}:{}),provider:selection.provider,...decision}));
    let provider: Provider;
    switch (selection.provider) {
      case "subscription":
        provider = new OpenAIProvider({ mode: "proxy", baseURL: this.subscription.baseURL, apiKey: await this.subscription.clientKey(), model: selection.model, transport: "http", onRetry, ...(selection.reasoning_effort ? { reasoningEffort: selection.reasoning_effort } : {}) });
        break;
      case "chatgpt":
        if (!config.tokenFile) throw new ProviderError("configuration", "Connect a ChatGPT account on this computer first");
        provider = new OpenAIProvider({ mode: "chatgpt", model: selection.model, tokenFile: config.tokenFile, transport: config.transport ?? "http", serviceTier: "default", onRetry, ...(selection.reasoning_effort ? { reasoningEffort: selection.reasoning_effort } : {}) });
        break;
      case "openai": {
        const apiKey = access.api_key ?? config.apiKey;
        if (!apiKey) throw new ProviderError("configuration", "Connect an OpenAI API key in model settings");
        provider = new OpenAIProvider({ mode: "api", model: selection.model, apiKey, transport: "http", serviceTier: "default", onRetry, ...(selection.reasoning_effort ? { reasoningEffort: selection.reasoning_effort } : {}) });
        break;
      }
      case "anthropic": {
        const apiKey = access.api_key ?? this.connections.anthropicKey;
        if (!apiKey) throw new ProviderError("configuration", "Connect a Claude API key in model settings");
        provider = new AnthropicProvider({ model: selection.model, apiKey, onRetry });
        break;
      }
      default: return unreachable(selection.provider);
    }
    return { provider, release: async () => { await provider.close?.(); } };
  }
}
function unreachable(value: never): never { throw new ProviderError("configuration", `Unsupported provider: ${String(value)}`); }
