import { Database } from "bun:sqlite";
import { ToolObservations } from "./tool-observations.ts";
import { z } from "zod";
import { DaemonEvent } from "../../packages/protocol/index.ts";
import { RunCheckpoint } from "./active-context.ts";
import { completeToolBoundary } from "../../packages/provider/compaction.ts";
import { NativeContextArchive } from "./native-context-archive.ts";
import { DelegationJournal } from "./delegation-journal.ts";
import { SemanticMetadataJobs } from "./semantic-context-queue.ts";
import { StructureJobs } from './semantic-structure.ts';
export class JournalError extends Error { constructor(readonly code: string) { super(code); this.name = "JournalError"; } }
export class Journal {
  private readonly db: Database;
  readonly observations: ToolObservations;
  readonly children: DelegationJournal;
  readonly semantic: SemanticMetadataJobs;
  readonly structure: StructureJobs;
  private readonly archive:NativeContextArchive;
  constructor(path: string) {
    this.db = new Database(path, { create: true });
    this.observations = new ToolObservations(this.db);
    this.children = new DelegationJournal(this.db);
    this.semantic = new SemanticMetadataJobs(this.db);
    this.structure = new StructureJobs(this.db);
    this.archive=new NativeContextArchive(this.db);
    this.db.exec("PRAGMA journal_mode=WAL; PRAGMA synchronous=FULL; CREATE TABLE IF NOT EXISTS checkpoints(run TEXT PRIMARY KEY,payload TEXT NOT NULL,watermark INTEGER NOT NULL); CREATE TABLE IF NOT EXISTS actions(id TEXT PRIMARY KEY,run TEXT NOT NULL,state TEXT NOT NULL,result TEXT); CREATE TABLE IF NOT EXISTS runs(id TEXT PRIMARY KEY,state TEXT NOT NULL); CREATE TABLE IF NOT EXISTS outbox(id TEXT PRIMARY KEY,event TEXT NOT NULL); CREATE TABLE IF NOT EXISTS commands(id TEXT PRIMARY KEY); CREATE TABLE IF NOT EXISTS settings(key TEXT PRIMARY KEY,value TEXT NOT NULL); CREATE TABLE IF NOT EXISTS memory_jobs(run TEXT PRIMARY KEY,payload TEXT NOT NULL,retry_at INTEGER NOT NULL DEFAULT 0); CREATE TABLE IF NOT EXISTS rejected_events(id TEXT PRIMARY KEY,event TEXT NOT NULL,reason TEXT NOT NULL);");
  }
  start(run: string): void { this.db.query("INSERT INTO runs VALUES(?,'running')").run(run); }
  checkpoint(value: RunCheckpoint): void {
    this.db.transaction(()=>this.putCheckpoint(value))();
  }
  private putCheckpoint(value:RunCheckpoint):void{
    if (!completeToolBoundary(value.input)) throw new JournalError("checkpoint_requires_complete_tool_boundary");
    this.archive.assertHead(value);
      const pending=this.db.query("SELECT id FROM actions WHERE run=? AND state<>'completed' LIMIT 1").get(value.assignment.run_id);
      if(pending)throw new JournalError("checkpoint_has_uncertain_effects");
      this.db.query("INSERT OR REPLACE INTO checkpoints VALUES(?,?,COALESCE((SELECT MAX(rowid) FROM actions WHERE run=?),0))").run(value.assignment.run_id,JSON.stringify(value),value.assignment.run_id);
  }
  archiveCheckpoint(value:RunCheckpoint,signal:AbortSignal):RunCheckpoint{return this.archive.commit(value,signal,next=>this.putCheckpoint(next));}
  originalInput(run:string){return this.archive.originalInput(run);}
  assignmentLane(run:string):'foreground'|'background'|undefined{
    const row=z.object({lane:z.enum(['foreground','background']).nullable()}).nullable().parse(this.db.query("SELECT json_extract(payload,'$.assignment.lane') AS lane FROM checkpoints WHERE run=?").get(run));
    return row?.lane??undefined;
  }
  recoverable(run: string): RunCheckpoint | null {
    return this.db.transaction(()=>{
    const row=z.object({payload:z.string()}).nullable().parse(this.db.query("SELECT payload FROM checkpoints c WHERE c.run=? AND NOT EXISTS(SELECT 1 FROM actions a WHERE a.run=c.run AND (a.rowid>c.watermark OR a.state<>'completed'))").get(run));
    if(!row)return null;
    const parsed=RunCheckpoint.safeParse(JSON.parse(row.payload));
    if(!parsed.success||parsed.data.assignment.run_id!==run||!completeToolBoundary(parsed.data.input)||!this.archive.validHead(parsed.data))return null;
    return parsed.data;
    })();
  }
  suspend(run:string):void { this.db.query("UPDATE runs SET state='suspended' WHERE id=?").run(run); }
  suspended():readonly string[] { return z.array(z.object({id:z.string()})).parse(this.db.query("SELECT id FROM runs WHERE state='suspended'").all()).map(row=>row.id); }
  resume(run:string):void { this.db.query("UPDATE runs SET state='running' WHERE id=?").run(run); }
  finish(run: string): void { this.db.query("UPDATE runs SET state='finished' WHERE id=?").run(run); }
  interrupted(): readonly string[] { return z.array(z.object({ id: z.string() })).parse(this.db.query("SELECT id FROM runs WHERE state='running'").all()).map(r => r.id); }
  begin(run: string, id: string): void {
    const existing = this.db.query("SELECT id FROM actions WHERE id=?").get(id);
    if (existing) throw new JournalError("action_already_recorded_reconciliation_required");
    this.db.query("INSERT INTO actions(id,run,state) VALUES(?,?,'started')").run(id, run);
  }
  resumeSafe(run: string): boolean { return this.recoverable(run)!==null || this.db.query("SELECT id FROM actions WHERE run=? LIMIT 1").get(run) === null; }
  complete(id: string, result: string): void { this.db.query("UPDATE actions SET state='completed',result=? WHERE id=?").run(result, id); }
  enqueue(event: z.infer<typeof DaemonEvent>): void { this.db.query("INSERT OR IGNORE INTO outbox VALUES(?,?)").run(event.event_id, JSON.stringify(event)); }
  pending(): readonly z.infer<typeof DaemonEvent>[] { return z.array(z.object({ event: z.string() })).parse(this.db.query("SELECT event FROM outbox ORDER BY rowid").all()).map(r => DaemonEvent.parse(JSON.parse(r.event))); }
  rejectEvent(id: string, reason: string): void {
    this.db.transaction(() => { this.db.query("INSERT OR IGNORE INTO rejected_events SELECT id,event,? FROM outbox WHERE id=?").run(reason, id); this.delivered(id); })();
  }
  wasRejected(id: string): boolean { return this.db.query("SELECT 1 FROM rejected_events WHERE id=?").get(id) !== null; }
  rejected(): readonly { readonly event: z.infer<typeof DaemonEvent>; readonly reason: string }[] {
    return z.array(z.object({ event: z.string(), reason: z.string() })).parse(this.db.query("SELECT event,reason FROM rejected_events ORDER BY rowid").all()).map(row => ({ event: DaemonEvent.parse(JSON.parse(row.event)), reason: row.reason }));
  }
  delivered(id: string): void { this.db.query("DELETE FROM outbox WHERE id=?").run(id); }
  control(): "agent" | "user" { const row = this.db.query("SELECT value FROM settings WHERE key='control'").get(); return row ? z.object({ value: z.enum(["agent", "user"]) }).parse(row).value : "agent"; }
  setControl(value: "agent" | "user"): void { this.db.query("INSERT OR REPLACE INTO settings VALUES('control',?)").run(value); }
  commandApplied(id: string): boolean { return this.db.query("SELECT id FROM commands WHERE id=?").get(id) !== null; }
  recordCommand(id: string): void { this.db.query("INSERT OR IGNORE INTO commands VALUES(?)").run(id); }
  completeTurn(event: Extract<z.infer<typeof DaemonEvent>, { kind: "state" }>): void {
    if (event.state !== "succeeded") throw new JournalError("completion_requires_success");
    this.db.transaction(() => {
      this.enqueue(event);
      this.queueMemory(event.run_id, JSON.stringify({ kind: "pending", derivation_id: crypto.randomUUID() }));
    })();
  }
  reopenTurn(run: string, eventId: string): void { this.db.transaction(() => { this.delivered(eventId); this.finishMemory(run); })(); }
  queueMemory(run: string, payload: string): void { this.db.query("INSERT INTO memory_jobs(run,payload) VALUES(?,?) ON CONFLICT(run) DO UPDATE SET payload=excluded.payload").run(run, payload); }
  memoryJob(): { run: string; payload: string } | null { return z.object({ run: z.string(), payload: z.string() }).nullable().parse(this.db.query("SELECT j.run,j.payload FROM memory_jobs j WHERE j.retry_at<=? AND NOT EXISTS(SELECT 1 FROM outbox o WHERE json_extract(o.event,'$.kind')='state' AND json_extract(o.event,'$.state')='succeeded' AND json_extract(o.event,'$.run_id')=j.run) ORDER BY j.rowid LIMIT 1").get(Date.now())); }
  retryMemory(run: string): void { this.db.query("UPDATE memory_jobs SET retry_at=? WHERE run=?").run(Date.now() + 60000, run); }
  finishMemory(run: string): void { this.db.query("DELETE FROM memory_jobs WHERE run=?").run(run); }
  close(): void { this.db.close(); }
}
