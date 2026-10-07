import { expect, test } from "bun:test";
import { copyFileSync, mkdirSync, mkdtempSync, unlinkSync } from "node:fs";
import { join } from "node:path";
import { Journal } from "../services/daemon/journal.ts";
import type { RunCheckpoint } from "../services/daemon/active-context.ts";

test("isolated restored Journal refuses uncertain effects and preserves outbox order", () => {
  // Given: an eligible checkpoint becomes unsafe after an unresolved external effect.
  const evidence = join(import.meta.dir, "../.omo/evidence/journal-backup");
  mkdirSync(evidence, { recursive: true });
  const directory = mkdtempSync(join(evidence, "semantics-"));
  const source = join(directory, "source.sqlite");
  const run = crypto.randomUUID();
  const action = crypto.randomUUID();
  const events = [crypto.randomUUID(), crypto.randomUUID()];
  const original = new Journal(source);
  original.start(run);
  const checkpoint: RunCheckpoint = {
    version: 1,
    assignment: {
      run_id: run,
      task: { id: crypto.randomUUID(), conversation_id: crypto.randomUUID(), objective: "fixture", state: "running", reason: null, created_at: new Date().toISOString(), updated_at: new Date().toISOString() },
      messages: [], instructions: "", memory: [],
    },
    input: [], cursor: 0, seenCallIds: [],
    artifacts: { directory, seen: [], inlineBytes: 0 }, inputTokens: 0,
  };
  original.checkpoint(checkpoint);
  expect(original.recoverable(run)).toEqual(checkpoint);
  expect(original.resumeSafe(run)).toBe(true);
  original.begin(run, action);
  original.finish(run);
  for (const event of events) original.enqueue({ kind: "heartbeat", event_id: event });
  original.close();
  const cli = join(import.meta.dir, "../scripts/backup-journal.py");
  const bundle = join(directory, "bundle");
  const restore = join(directory, "restore");
  const backup = Bun.spawnSync(["python3", cli, "backup", source, bundle], { timeout: 30_000 });
  expect(backup.exitCode).toBe(0);
  unlinkSync(source);
  const verification = Bun.spawnSync(["python3", cli, "verify", bundle, restore], { timeout: 30_000 });
  expect(verification.exitCode).toBe(0);
  const disposable = join(directory, "disposable.sqlite");
  copyFileSync(join(restore, "journal.sqlite"), disposable);
  // When: only the independent second copy is opened by Journal.
  const restored = new Journal(disposable);
  try {
    // Then: restoration never makes an uncertain effect eligible for replay.
    expect(restored.recoverable(run)).toBeNull();
    expect(restored.resumeSafe(run)).toBe(false);
    expect(() => restored.begin(run, action)).toThrow("action_already_recorded_reconciliation_required");
    expect(restored.pending().map(event => event.event_id)).toEqual(events);
    console.log(JSON.stringify({ directory, checkpointInitiallyRecoverable: true, checkpointRejectedAfterUncertainAction: true, recoverable: null, resumeSafe: false, duplicateBegin: "refused", outboxOrder: "preserved" }));
  } finally {
    restored.close();
  }
});
