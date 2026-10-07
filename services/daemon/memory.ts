import { controlErrorCode, RetentionErrorCode } from "./control-diagnostic";
import { ResponsibilityQueue } from "./responsibilities.ts";
import { z } from "zod";
import type { KyInstance } from "ky";
import type { Provider } from "../../packages/provider/index.ts";
import { MemoryError } from "../../packages/memory/schema.ts";
import { retentionAllows, validateRetention } from "../../packages/memory/retention.ts";
import { ExtractionRequest } from "../../packages/memory/schema.ts";
import { extractMemory } from "../../packages/memory/extract.ts";
import { TaskSourcePage } from "../../packages/protocol/index.ts";
import type { Journal } from "./journal.ts";
import type { RunModelResolver, ProviderLease } from "./model-resolver.ts";

const Job = z.discriminatedUnion("kind", [z.object({ kind: z.literal("pending"), derivation_id: z.uuid(), after_sequence: z.number().int().min(0).default(0) }), z.object({ kind: z.literal("extracted"), request: ExtractionRequest, after_sequence: z.number().int().min(0).default(0), next_after_sequence: z.number().int().nullable().default(null) })]);
export class MemoryQueue {
  private active: Promise<void> | undefined;
  private readonly responsibilities: ResponsibilityQueue;
  private readonly abort = new AbortController();
  constructor(private readonly dependencies: { readonly journal: Journal; readonly provider: Provider; readonly http: KyInstance; readonly models?: RunModelResolver }) { this.responsibilities = new ResponsibilityQueue(dependencies); }
  tick(): void {
    this.responsibilities.tick();
    if (this.active) return;
    const entry = this.dependencies.journal.memoryJob();
    if (!entry) return;
    this.active = this.process(entry).finally(() => { this.active = undefined; });
  }
  private async process(entry: { readonly run: string; readonly payload: string }): Promise<void> {
    let lease: ProviderLease | undefined;
    try {
      const job = Job.parse(JSON.parse(entry.payload));
      let request: ExtractionRequest;
      let nextAfter:number|null=null;
      switch (job.kind) {
        case "pending": {
          const snapshot = TaskSourcePage.parse(await this.dependencies.http.get(`v1/daemon/context/${entry.run}`, { searchParams:{view:"task_sources",after:job.after_sequence},signal: this.abort.signal }).json());
          if (!snapshot.retention_context) throw new MemoryError("retention_context_unsupported");
          if (snapshot.messages.length === 0) { this.dependencies.journal.finishMemory(entry.run); return; }
          const sources = snapshot.messages;
          nextAfter=snapshot.next_after_sequence;
          lease = await this.dependencies.models?.forRun(entry.run, this.abort.signal);
          const result = await extractMemory(lease?.provider ?? this.dependencies.provider, { sources, known: snapshot.memory, retention_context: snapshot.retention_context }, this.abort.signal);
          request = { ...result, run_id: entry.run, derivation_id: job.derivation_id, source_ids: sources.map(s => s.id) };
          this.dependencies.journal.queueMemory(entry.run, JSON.stringify({ kind: "extracted", request, after_sequence: job.after_sequence, next_after_sequence:nextAfter }));
          break;
        }
        case "extracted": {
          const snapshot = TaskSourcePage.parse(await this.dependencies.http.get(`v1/daemon/context/${entry.run}`, { searchParams: { view: "task_sources", after: job.after_sequence }, signal: this.abort.signal }).json());
          if (!snapshot.retention_context) throw new MemoryError("retention_context_unsupported");
          try {
            if (!job.request.retention) throw new MemoryError("retention_assessment_required");
            await validateRetention(snapshot.retention_context, job.request.retention);
          } catch (error) {
            if (!(error instanceof MemoryError)) throw error;
            this.dependencies.journal.queueMemory(entry.run, JSON.stringify({ kind: "pending", derivation_id: crypto.randomUUID(), after_sequence: job.after_sequence }));
            throw error;
          }
          request = { ...job.request, extraction: { ...job.request.extraction, claims: job.request.extraction.claims.filter(claim => {
            const source = snapshot.messages.find(s => s.id === claim.evidence.source_message_id);
            if (!source || !snapshot.retention_context || !job.request.retention) throw new MemoryError("retention_source_missing");
            return retentionAllows(snapshot.retention_context, job.request.retention.decisions, source.sequence);
          }) } }; nextAfter = job.next_after_sequence; break;
        }
        default: return assertNever(job);
      }
      await this.dependencies.http.post("v1/daemon/memory", { json: request, signal: this.abort.signal });
      if(nextAfter===null)this.dependencies.journal.finishMemory(entry.run);
      else this.dependencies.journal.queueMemory(entry.run,JSON.stringify({kind:"pending",derivation_id:crypto.randomUUID(),after_sequence:nextAfter}));
    } catch (error) {
      if (!(error instanceof Error)) throw error;
      this.dependencies.journal.retryMemory(entry.run);
      const diagnostic = RetentionErrorCode.safeParse(error instanceof MemoryError ? error.code : await controlErrorCode(error));
      if (diagnostic.success) console.warn(JSON.stringify({ event: "daemon.memory.retention_retry", run_id: entry.run, code: diagnostic.data }));
    } finally {
      await lease?.release();
    }
  }
  async stop(): Promise<void> { this.abort.abort(); await Promise.all([this.active, this.responsibilities.stop()]); }
}
function assertNever(value: never): never { throw new TypeError(`Invalid memory job ${String(value)}`); }
