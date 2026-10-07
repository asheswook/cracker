import type { Database } from "bun:sqlite";
import type { KyInstance } from "ky";
import { HTTPError } from "ky";
import { z } from "zod";
import { Assignment } from "../../packages/protocol/index.ts";
import type { Provider } from "../../packages/provider/index.ts";
import type { ProviderLease, RunModelResolver } from "./model-resolver.ts";
import { SemanticCheckpoint } from "./semantic-context-state.ts";
import { SemanticContexts, SemanticIndexError } from "./semantic-context.ts";

const Job = z.object({ runId: z.uuid(), taskId: z.uuid(), binding: Assignment.shape.model_binding, state: SemanticCheckpoint, delivery_revision: z.string().optional() });
type Job = z.infer<typeof Job>;
const Entry = z.object({ id: z.string(), payload: z.string(), attempts: z.number() });
export async function semanticMetadataDiagnostic(error: Error): Promise<{ readonly type: string; readonly code?: string }> {
  if (!(error instanceof HTTPError)) {
    const detail = z.object({ code: z.string().regex(/^[A-Za-z_][A-Za-z0-9_]{0,79}$/) }).safeParse(error);
    return { type: error.constructor.name, ...(detail.success ? { code: detail.data.code } : {}) };
  }
  try {
    const result = z.object({ error: z.object({ code: z.string().regex(/^[a-z_]{1,80}$/) }) }).safeParse(await error.response.clone().json());
    return { type: error.name, ...(result.success ? { code: result.data.error.code } : {}) };
  } catch (parsing) { if (!(parsing instanceof SyntaxError)) throw parsing; return { type: error.name }; }
}
export class SemanticMetadataJobs {
  constructor(private readonly db: Database) {
    db.exec("CREATE TABLE IF NOT EXISTS semantic_metadata_jobs(id TEXT PRIMARY KEY,payload TEXT NOT NULL,attempts INTEGER NOT NULL DEFAULT 0,retry_at INTEGER NOT NULL DEFAULT 0)");
    db.exec("CREATE TABLE IF NOT EXISTS semantic_metadata_receipts(id TEXT PRIMARY KEY,run_id TEXT NOT NULL,finished_at INTEGER NOT NULL)");
  }
  enqueue(job: Job): void {
    const payload = JSON.stringify(job), id = new Bun.CryptoHasher("sha256").update(payload).digest("hex");
    this.db.transaction(() => {
      this.db.query("DELETE FROM semantic_metadata_receipts WHERE finished_at<? AND NOT EXISTS(SELECT 1 FROM runs WHERE runs.id=semantic_metadata_receipts.run_id AND runs.state IN ('running','suspended'))").run(Date.now() - 7 * 86400000);
      this.db.query("INSERT OR IGNORE INTO semantic_metadata_jobs(id,payload) SELECT ?,? WHERE NOT EXISTS(SELECT 1 FROM semantic_metadata_receipts WHERE id=?)").run(id, payload, id);
    })();
  }
  next(now = Date.now()): z.infer<typeof Entry> | null { return Entry.nullable().parse(this.db.query("SELECT id,payload,attempts FROM semantic_metadata_jobs WHERE retry_at>=0 AND retry_at<=? ORDER BY rowid LIMIT 1").get(now)); }
  save(id: string, job: Job): void { this.db.query("UPDATE semantic_metadata_jobs SET payload=? WHERE id=?").run(JSON.stringify(job), id); }
  park(id: string): void { this.db.query("UPDATE semantic_metadata_jobs SET retry_at=-1,attempts=attempts+1 WHERE id=?").run(id); }
  retry(entry: z.infer<typeof Entry>): void { this.db.query("UPDATE semantic_metadata_jobs SET attempts=attempts+1,retry_at=? WHERE id=?").run(Date.now() + Math.min(300000, 5000 * 2 ** Math.min(entry.attempts, 6)), entry.id); }
  finish(id: string): void {
    this.db.transaction(() => {
      this.db.query("INSERT OR IGNORE INTO semantic_metadata_receipts(id,run_id,finished_at) SELECT id,json_extract(payload,'$.runId'),? FROM semantic_metadata_jobs WHERE id=?").run(Date.now(), id);
      this.db.query("DELETE FROM semantic_metadata_jobs WHERE id=?").run(id);
    })();
  }
}
export class SemanticMetadataQueue {
  private active: Promise<void> | undefined;
  private readonly abort = new AbortController();
  constructor(private readonly dependencies: { readonly jobs: SemanticMetadataJobs; readonly http: KyInstance; readonly provider: Provider; readonly models?: RunModelResolver }) {}
  enqueue(assignment: Assignment, state: SemanticCheckpoint, deliveryRevision?: string): void {
    this.dependencies.jobs.enqueue({ runId: assignment.run_id, taskId: assignment.task.id, ...(assignment.model_binding ? { binding: assignment.model_binding } : {}), state, ...(deliveryRevision ? { delivery_revision: deliveryRevision } : {}) });
  }
  tick(): void { if (!this.active) this.active = this.process().finally(() => { this.active = undefined; }); }
  async process(now = Date.now()): Promise<void> {
    const entry = this.dependencies.jobs.next(now);
    if (!entry) return;
    const job = Job.parse(JSON.parse(entry.payload));
    let lease: ProviderLease | undefined;
    let controller: SemanticContexts | undefined;
    try {
      lease = await this.dependencies.models?.forRun(job.runId, this.abort.signal, job.binding);
      controller = new SemanticContexts({ http: this.dependencies.http, runId: job.runId, taskId: job.taskId, provider: lease?.provider ?? this.dependencies.provider, mode: "backfill" }, job.state);
      const current = controller;
      await current.drain(this.abort.signal, () => this.dependencies.jobs.save(entry.id, { ...job, state: current.checkpoint() }));
      this.dependencies.jobs.finish(entry.id);
    } catch (error) {
      if (!(error instanceof Error)) throw error;
      if (this.abort.signal.aborted) return;
      const diagnostic = await semanticMetadataDiagnostic(error);
      if (error instanceof HTTPError && error.response.status === 409 && controller) {
        if (diagnostic.code && ["stale_revision", "stale_source", "stale_run", "retention_denied", "invalid_source", "invalid_evidence", "unsupported_fact", "invalid_notes", "note_conflict"].includes(diagnostic.code)) {
          controller.refreshNotes();
          this.dependencies.jobs.save(entry.id, { ...job, state: controller.checkpoint() });
        }
      }
      if (error instanceof SemanticIndexError && error.code === "source_boundary_unavailable") {
        this.dependencies.jobs.park(entry.id);
        console.warn(JSON.stringify({ event: "daemon.semantic_metadata.reconciliation_required", run_id: job.runId, code: error.code }));
        return;
      }
      this.dependencies.jobs.retry(entry);
      console.warn(JSON.stringify({ event: "daemon.semantic_metadata.retry", run_id: job.runId, attempt: entry.attempts + 1, ...diagnostic }));
    } finally { await lease?.release(); }
  }
  async stop(): Promise<void> { this.abort.abort(); await this.active; }
}
