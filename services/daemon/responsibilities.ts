import { HTTPError, type KyInstance } from "ky";
import { z } from "zod";
import type { Provider } from "../../packages/provider/index.ts";
import { ResponsibilitySnapshot } from "../../packages/memory/responsibility-schema.ts";
import { evaluateResponsibility } from "../../packages/memory/responsibility-evaluate.ts";
import type { RunModelResolver, ProviderLease } from "./model-resolver.ts";
export class ResponsibilityQueue {
  private active: Promise<void> | undefined;
  private readonly abort = new AbortController();
  private nextPoll = 0;
  constructor(private readonly dependencies: { readonly http: KyInstance; readonly provider: Provider; readonly models?: RunModelResolver }) {}
  tick(): void {
    if (this.active || Date.now() < this.nextPoll) return;
    this.nextPoll = Date.now() + 30000;
    this.active = this.process().finally(() => { this.active = undefined; });
  }
  private async process(): Promise<void> {
    try {
      const response = z.object({ responsibilities: z.array(ResponsibilitySnapshot) }).parse(await this.dependencies.http.get("v1/daemon/responsibilities", { signal: this.abort.signal }).json());
      for (const snapshot of response.responsibilities) {
        if (this.abort.signal.aborted) return;
        let lease: ProviderLease | undefined;
        try {
          lease = await this.dependencies.models?.current(this.abort.signal);
          const evaluation = await evaluateResponsibility(lease?.provider ?? this.dependencies.provider, snapshot, this.abort.signal);
          await this.dependencies.http.post("v1/daemon/responsibilities/evaluate", { json: { responsibility_id: snapshot.id, context_hash: snapshot.context_hash, evaluation }, signal: this.abort.signal });
        } catch (error) {
          if (!(error instanceof Error)) throw error;
          if (this.abort.signal.aborted) return;
          const error_code = error instanceof HTTPError && error.response.status === 409 ? "stale_evidence" : error instanceof z.ZodError || error instanceof SyntaxError ? "invalid_output" : "provider_error";
          await this.dependencies.http.post("v1/daemon/responsibilities/failure", { json: { responsibility_id: snapshot.id, error_code }, signal: this.abort.signal });
        } finally {
          await lease?.release();
        }
      }
    } catch (error) {
      if (!(error instanceof Error)) throw error;
      // The responsibility remains due in PostgreSQL; network failure never acknowledges it.
      this.nextPoll = Date.now() + 60000;
    }
  }
  async stop(): Promise<void> { this.abort.abort(); await this.active; }
}
