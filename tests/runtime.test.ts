import { describe, test, expect } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Journal } from "../services/daemon/journal.ts";
import { execute } from "../services/daemon/shell.ts";

describe("runtime durable execution", () => {
  test("real shell returns exit status and output", async () => {
    // Given
    const signal = new AbortController().signal;
    // When
    const result = await execute(["bash", "-lc", "printf journal-check; exit 7"], signal);
    // Then
    expect(JSON.parse(result)).toEqual({ exit_code: 7, output: "journal-check" });
  });
  test("aborted subprocess exits without completing", async () => {
    // Given
    const controller = new AbortController();
    // When
    const result = execute(["bash", "-lc", "sleep 30"], controller.signal);
    controller.abort();
    // Then
    await expect(result).rejects.toThrow("aborted");
  });
  test("restart preserves uncertain actions and rejects replay", async () => {
    // Given
    const dir = await mkdtemp(join(tmpdir(), "assistant-journal-"));
    const path = join(dir, "journal.sqlite");
    const initial = new Journal(path);
    initial.start("run"); initial.begin("run", "action"); initial.close();
    // When
    const recovered = new Journal(path);
    // Then
    try { expect(recovered.interrupted()).toEqual(["run"]); expect(() => recovered.begin("run", "action")).toThrow("reconciliation_required"); }
    finally { recovered.close(); await rm(dir, { recursive: true }); }
  });
  test("outbox survives restart with the same event ID", async () => {
    // Given
    const dir = await mkdtemp(join(tmpdir(), "assistant-outbox-"));
    const path = join(dir, "journal.sqlite");
    const event = { kind: "heartbeat", event_id: crypto.randomUUID() } as const;
    const first = new Journal(path); first.enqueue(event); first.close();
    // When
    const recovered = new Journal(path);
    // Then
    try { expect(recovered.pending()).toEqual([event]); }
    finally { recovered.close(); await rm(dir, { recursive: true }); }
  });
});

test("completion checkpoint retains memory job across restart but waits for ACK", async () => {
  // Given a completion written before the server has acknowledged it.
  const dir = await mkdtemp(join(tmpdir(), "assistant-completion-")), path = join(dir, "journal.sqlite");
  const run = crypto.randomUUID(), event = { kind: "state", event_id: crypto.randomUUID(), run_id: run, state: "succeeded", reason: null } as const;
  const first = new Journal(path); first.start(run); first.completeTurn(event); first.close();
  // When the daemon restarts and later delivers the same event.
  const recovered = new Journal(path);
  const before = recovered.memoryJob(); recovered.delivered(event.event_id);
  // Then
  try { expect(before).toBeNull(); expect(recovered.memoryJob()?.run).toBe(run); }
  finally { recovered.close(); await rm(dir, { recursive: true }); }
});
