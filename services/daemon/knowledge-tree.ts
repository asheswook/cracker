/**
 * Daemon side of the knowledge tree:
 * - TreeJobs (local SQLite): runs that carry knowledge_tree_mode shadow|on, an enqueue outbox (retried until the control
 *   queue accepts), and the rejected-pair memo.
 * - KnowledgeTree: background growth worker (claim → grow → finish/fail, single flight) and question-time retrieval.
 * The control queue (knowledge_tree_queue) owns ordering, leases, backoff and parking.
 */
import type { Database } from 'bun:sqlite';
import { HTTPError, type KyInstance } from 'ky';
import { z } from 'zod';
import type { Assignment, DaemonEvent } from '../../packages/protocol/index.ts';
import type { Provider } from '../../packages/provider/index.ts';
import { treeClient, type TreeClient } from './knowledge-tree-client.ts';
import type { Snapshot } from '../../packages/knowledge-tree/schema.ts';
import { growExchange } from './knowledge-tree-growth.ts';
import { TreeValidationExhausted } from './knowledge-tree-llm.ts';
import { retrieveTree, type Auxiliary, type TreeRetrievalResult } from './knowledge-tree-retrieval.ts';
import { auxiliaryTimeoutMs } from './auxiliary-model.ts';
import type { RunModelResolver } from './model-resolver.ts';

const Mode = z.enum(['off', 'shadow', 'on']);
export const treeMode = (assignment: Pick<Assignment, 'knowledge_tree_mode'>) => Mode.parse(assignment.knowledge_tree_mode ?? 'off');

export class TreeJobs {
  constructor(private readonly db: Database) {
    db.exec(`CREATE TABLE IF NOT EXISTS knowledge_tree_runs(run TEXT PRIMARY KEY,mode TEXT NOT NULL,at INTEGER NOT NULL);
      CREATE TABLE IF NOT EXISTS knowledge_tree_outbox(user_message_id TEXT PRIMARY KEY,run TEXT NOT NULL,attempts INTEGER NOT NULL DEFAULT 0,retry_at INTEGER NOT NULL DEFAULT 0);
      CREATE TABLE IF NOT EXISTS knowledge_tree_memo(key TEXT PRIMARY KEY,value INTEGER NOT NULL);`);
  }
  register(assignment: Assignment, now = Date.now()) {
    const mode = treeMode(assignment);
    if (mode === 'off') return;
    this.db.query('INSERT OR REPLACE INTO knowledge_tree_runs VALUES(?,?,?)').run(assignment.run_id, mode, now);
  }
  anyOn() { return z.object({ n: z.number() }).parse(this.db.query("SELECT count(*) AS n FROM knowledge_tree_runs WHERE mode='on'").get()).n > 0; }
  modeOf(run: string) { const row = z.object({ mode: Mode }).nullable().parse(this.db.query('SELECT mode FROM knowledge_tree_runs WHERE run=?').get(run)); return row?.mode ?? 'off'; }
  /** Most recent tree-enabled run: its credential scope is used for workspace-wide background routes. */
  latestRun() { return z.object({ run: z.string() }).nullable().parse(this.db.query('SELECT run FROM knowledge_tree_runs ORDER BY at DESC LIMIT 1').get())?.run ?? null; }
  /** A final assistant reply to a real user message was delivered: queue that exchange for growth. */
  delivered(event: DaemonEvent) {
    if (event.kind !== 'message' || !event.response_to_message_id) return;
    // Final replies carry phase=final_answer, or (providers without phases) no phase and output_kind=answer.
    const final = event.phase === 'final_answer' || (event.phase == null && 'output_kind' in event && event.output_kind === 'answer');
    if (!final) return;
    if (this.modeOf(event.run_id) === 'off') return;
    this.db.query('INSERT OR IGNORE INTO knowledge_tree_outbox(user_message_id,run) VALUES(?,?)').run(event.response_to_message_id, event.run_id);
  }
  dueOutbox(now = Date.now(), limit = 16) { return z.array(z.object({ user_message_id: z.string(), run: z.string(), attempts: z.number() })).parse(this.db.query('SELECT user_message_id,run,attempts FROM knowledge_tree_outbox WHERE retry_at<=? ORDER BY rowid LIMIT ?').all(now, limit)); }
  sent(id: string) { this.db.query('DELETE FROM knowledge_tree_outbox WHERE user_message_id=?').run(id); }
  retryOutbox(id: string, attempts: number, now = Date.now()) {
    if (attempts >= 20) { this.sent(id); return; }
    this.db.query('UPDATE knowledge_tree_outbox SET attempts=attempts+1,retry_at=? WHERE user_message_id=?').run(now + Math.min(300000, 5000 * 2 ** Math.min(6, attempts)), id);
  }
  memo(): Record<string, number> { return Object.fromEntries(z.array(z.object({ key: z.string(), value: z.number() })).parse(this.db.query('SELECT key,value FROM knowledge_tree_memo').all()).map(r => [r.key, r.value])); }
  saveMemo(memo: Record<string, number>) { const put = this.db.query('INSERT OR REPLACE INTO knowledge_tree_memo VALUES(?,?)'); this.db.transaction(() => { for (const [k, v] of Object.entries(memo)) put.run(k, v); })(); }
}

const transientCodes = new Set([408, 425, 429, 500, 502, 503, 504]);
/** Question-time snapshot cache: revalidated by tree version (one cheap round trip), refreshed after growth. */
export class SnapshotCache {
  private value: { version: string; snapshot: Snapshot; at: number } | undefined;
  private inflight: Promise<Snapshot> | undefined;
  constructor(private readonly ttlMs = 15_000) {}
  invalidate() { if (this.value) this.value.at = 0; }
  /** Fresh within ttl → immediate; otherwise revalidate (unchanged → reuse body). */
  get(client: TreeClient, signal: AbortSignal): Promise<Snapshot> {
    const v = this.value;
    if (v && Date.now() - v.at < this.ttlMs) return Promise.resolve(v.snapshot);
    this.inflight ??= (async () => {
      try {
        const r = await client.snapshotSince(v?.version, signal);
        if (r.unchanged && v) { v.at = Date.now(); return v.snapshot; }
        if (!r.snapshot) throw new Error('snapshot_missing');
        this.value = { version: r.version, snapshot: r.snapshot, at: Date.now() };
        return r.snapshot;
      } finally { this.inflight = undefined; }
    })();
    return this.inflight;
  }
  /** Background warm-up; errors are ignored (question time revalidates). */
  warm(client: TreeClient, signal: AbortSignal) { if (!this.value || Date.now() - this.value.at >= this.ttlMs) void this.get(client, signal).catch(() => undefined); }
}
const IDLE_POLL_MS = 30_000, FAILURE_PAUSE_MS = 15_000;
export class KnowledgeTree {
  private active: Promise<void> | undefined;
  private idleUntil = 0;
  private readonly snapshots = new SnapshotCache();
  private readonly abort = new AbortController();
  constructor(private readonly dependencies: { jobs: TreeJobs; http: KyInstance; provider: Provider; models?: RunModelResolver; auxTimeoutMs?: number; log?: (record: Record<string, unknown>) => void; busy?: () => boolean }) {}
  close() { this.abort.abort(); }
  tick() {
    if (this.active) return;
    this.active = this.work().catch(error => { if (!this.abort.signal.aborted) this.log({ event: 'daemon.knowledge_tree.tick_failed', error: error instanceof Error ? error.message.slice(0, 200) : 'unknown' }); }).finally(() => { this.active = undefined; });
  }
  async idle() { await this.active; }
  private log(record: Record<string, unknown>) { (this.dependencies.log ?? (r => console.warn(JSON.stringify(r))))(record); }
  private async work() {
    const { jobs, http } = this.dependencies, signal = this.abort.signal;
    for (const item of jobs.dueOutbox()) {
      try { await treeClient(http, null).enqueue(item.user_message_id, signal); jobs.sent(item.user_message_id); }
      catch (error) { if (signal.aborted) return; jobs.retryOutbox(item.user_message_id, item.attempts); this.log({ event: 'daemon.knowledge_tree.enqueue_deferred', status: error instanceof HTTPError ? error.response.status : null }); }
    }
    // Background growth is workspace-wide and independent of runs; it is enabled once any shadow/on run was seen.
    if (!jobs.latestRun()) return;
    if (jobs.anyOn()) this.snapshots.warm(treeClient(http, null), signal);
    // Growth is background work: it starts only while no conversation is being answered, so question-time retrieval
    // and the reply never queue behind tree writes (an exchange already in progress finishes).
    if (this.dependencies.busy?.()) return;
    // An empty queue is polled at most every IDLE_POLL_MS; after work, the next item is claimed immediately.
    if (Date.now() < this.idleUntil) return;
    const client = treeClient(http, null);
    const { item } = await client.claim(signal);
    if (!item) { this.idleUntil = Date.now() + IDLE_POLL_MS; return; }
    const started = performance.now();
    let lease: Awaited<ReturnType<RunModelResolver['current']>> | undefined;
    try {
      // Growth always uses the workspace's current model, as a live conversation would; it follows model changes.
      lease = await this.dependencies.models?.current(signal);
      const memo = jobs.memo();
      let result;
      for (let attempt = 0; ; attempt++) {
        const snapshot = await client.snapshot(signal);
        try { result = await growExchange({ client, provider: lease?.provider ?? this.dependencies.provider, signal, memo, snapshot, user_message_id: item.user_message_id, sequence: item.sequence }); break; }
        catch (error) {
          // A concurrent writer changed nodes this exchange read: re-read once and retry.
          if (attempt === 0 && error instanceof HTTPError && error.response.status === 409 && await code(error) === 'stale_revision') continue;
          throw error;
        }
      }
      jobs.saveMemo(memo);
      this.snapshots.invalidate();
      await client.finish(item.user_message_id, item.claim_id, signal);
      this.log({ event: 'daemon.knowledge_tree.grown', duration_ms: Math.round(performance.now() - started), ...result });
    } catch (error) {
      if (signal.aborted) return;
      // Back off the whole worker briefly after a failure so a persistent fault does not spin.
      this.idleUntil = Date.now() + FAILURE_PAUSE_MS;
      const reason = error instanceof TreeValidationExhausted ? `validation:${error.name_}` : error instanceof HTTPError ? `http_${error.response.status}:${await code(error) ?? ''}` : error instanceof Error ? error.message.slice(0, 300) : 'unknown';
      this.log({ event: 'daemon.knowledge_tree.grow_failed', reason, transient: error instanceof HTTPError && transientCodes.has(error.response.status) });
      await client.fail(item.user_message_id, item.claim_id, reason, signal).catch(() => undefined);
    } finally { await lease?.release(); }
  }
  /**
   * Question-time evidence from the tree, or null when the caller must use the old semantic + structure path.
   * Clef and the auxiliary model (same family as the run's model) run in parallel; see knowledge-tree-retrieval.ts.
   */
  async reference(assignment: Assignment, messageId: string, query: string, signal: AbortSignal, maxBytes?: number): Promise<TreeRetrievalResult> {
    const client = treeClient(this.dependencies.http, assignment.run_id);
    let auxiliary: Auxiliary = null;
    try {
      const lease = await this.dependencies.models?.auxiliary?.(signal, assignment.run_id);
      if (lease) auxiliary = { provider: lease.provider, timeoutMs: auxiliaryTimeoutMs(lease.model, this.dependencies.auxTimeoutMs), release: () => lease.release() };
    } catch (error) { if (signal.aborted) throw error; }
    try { return await retrieveTree({ client, query, messageId, auxiliary, signal, snapshot: () => this.snapshots.get(treeClient(this.dependencies.http, null), signal), ...(maxBytes === undefined ? {} : { maxBytes }) }); }
    catch (error) {
      if (signal.aborted) throw error;
      this.log({ event: 'daemon.knowledge_tree.reference_failed', run_id: assignment.run_id, status: error instanceof HTTPError ? error.response.status : null, error: error instanceof Error ? error.name : 'unknown' });
      return null;
    } finally { await auxiliary?.release(); }
  }
}
async function code(error: HTTPError) {
  const body = z.object({ error: z.object({ code: z.string() }) }).safeParse(await error.response.clone().json().catch(() => null));
  return body.success ? body.data.error.code : null;
}
