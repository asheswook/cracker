import { join } from "node:path";
import type { ResponseInputItem } from "../../packages/provider/index.ts";
import { ChildTarget, MessageChild, SpawnChild, WaitChild } from "./delegation-tools.ts";
import { runChild, type ChildEnvironment } from "./child-runner.ts";
import type { Child } from "./delegation-journal.ts";
export class Delegation {
  private readonly active = new Map<string, Promise<void>>();
  private readonly abort = new AbortController();
  private readonly failures: unknown[] = [];
  private readonly signal: AbortSignal;
  constructor(
    private readonly scope: {
      readonly runId: string;
      readonly directory: string;
      readonly instructions: readonly ResponseInputItem[];
    },
    private readonly environment: ChildEnvironment,
    private readonly concurrency = 3,
  ) {
    if (!Number.isInteger(concurrency) || concurrency < 1 || concurrency > 8)
      throw new RangeError("Agent concurrency must be 1–8");
    this.signal = AbortSignal.any([environment.signal, this.abort.signal]);
    environment.journal.recover(scope.runId);
    this.pump();
  }
  private rows(): Child[] {
    return this.environment.journal.list(this.scope.runId);
  }
  pending(): boolean {
    if (this.failures.length)
      throw new AggregateError(this.failures, "Child execution cleanup failed");
    return (
      this.active.size > 0 ||
      this.rows().some(
        (child) =>
          child.state === "queued" ||
          child.state === "running" ||
          child.state === "finishing" ||
          !child.consumed,
      )
    );
  }
  running(): boolean {
    return (
      this.active.size > 0 ||
      this.rows().some(
        (child) =>
          child.state === "queued" || child.state === "running" || child.state === "finishing",
      )
    );
  }
  private target(id: string): Child {
    const child = this.environment.journal.get(id);
    if (!child || child.parent !== this.scope.runId)
      throw new TypeError("Unknown child for this task");
    return child;
  }
  private snapshot(id: string): string {
    const child = this.target(id),
      terminal =
        !this.active.has(id) &&
        (child.state === "succeeded" || child.state === "failed" || child.state === "unknown");
    if (terminal) this.environment.journal.save({ ...child, consumed: true });
    return JSON.stringify({
      agent_id: child.id,
      state: this.active.has(id) ? "running" : child.state,
      result: terminal ? child.result : null,
      output_directory: child.directory,
    });
  }
  summary(): string {
    return JSON.stringify(
      this.rows().map((child) => ({
        agent_id: child.id,
        state: child.state,
        result_read: child.consumed,
      })),
    );
  }
  async tool(name: string, args: string, callId: string): Promise<string> {
    this.signal.throwIfAborted();
    switch (name) {
      case "spawn_agent": {
        const { task } = SpawnChild.parse(JSON.parse(args)),
          id = `${this.scope.runId}:${callId}`;
        if (!this.environment.journal.get(id) && this.rows().length >= 12)
          return JSON.stringify({ error: "task_agent_limit", limit: 12 });
        const directory = join(
          this.scope.directory,
          "agents",
          new Bun.CryptoHasher("sha256").update(id).digest("hex").slice(0, 24),
        );
        const child = this.environment.journal.create({
          id,
          parent: this.scope.runId,
          task,
          directory,
          state: "queued",
          input: [
            ...this.scope.instructions,
            {
              role: "system",
              content: `You are an independent subagent. Report findings, evidence, uncertainty and output file paths to your lead. Only the lead communicates with the user. Work only on the assigned scope and owned files; others share the VM. OUTPUT_DIR=${directory}. Do not control the shared desktop or start detached/background processes. Return a concise result when finished.`,
            },
            { role: "user", content: task },
          ],
          calls: [],
          result: null,
          consumed: false,
          turns: 0,
          mailbox: [],
          appliedMessages: [],
        });
        this.pump();
        return JSON.stringify({
          agent_id: child.id,
          state: child.state,
          output_directory: directory,
        });
      }
      case "agent_status":
        return this.snapshot(ChildTarget.parse(JSON.parse(args)).agent_id);
      case "message_agent": {
        const request = MessageChild.parse(JSON.parse(args)),
          child = this.target(request.agent_id);
        if (child.mailbox.some((message) => message.id === callId))
          return JSON.stringify({ agent_id: child.id, accepted: true });
        if (child.state === "unknown")
          return JSON.stringify({ error: "reconciliation_required", agent_id: child.id });
        this.environment.journal.message(child.id, { id: callId, text: request.message });
        const current = this.target(child.id);
        if (current.state === "succeeded" || current.state === "failed")
          this.environment.journal.save({
            ...current,
            state: "queued",
            consumed: false,
            result: null,
            turns: 0,
          });
        this.pump();
        return JSON.stringify({ agent_id: child.id, accepted: true });
      }
      case "wait_agent": {
        const request = WaitChild.parse(JSON.parse(args));
        this.target(request.agent_id);
        const work = this.active.get(request.agent_id);
        if (work && request.timeout_ms > 0) {
          let timer: ReturnType<typeof setTimeout> | undefined;
          try {
            await Promise.race([
              work,
              new Promise<void>((resolve) => {
                timer = setTimeout(resolve, request.timeout_ms);
              }),
            ]);
          } finally {
            clearTimeout(timer);
          }
        }
        return this.snapshot(request.agent_id);
      }
      default:
        throw new TypeError("Unknown delegation tool");
    }
  }
  steer(message: { readonly id: string; readonly text: string }): void {
    for (const child of this.rows())
      if (child.state === "queued" || child.state === "running" || child.state === "finishing")
        this.environment.journal.message(child.id, message);
  }
  private pump(): void {
    if (this.signal.aborted) return;
    for (const child of this.rows()) {
      if (this.active.size >= this.concurrency) break;
      if (child.state !== "queued" || this.active.has(child.id)) continue;
      const work = runChild(child, { ...this.environment, signal: this.signal });
      this.active.set(child.id, work);
      void work.then(
        () => this.settled(child.id),
        (error) => {
          this.failures.push(error);
          const current = this.target(child.id);
          this.environment.journal.save({
            ...current,
            state: "unknown",
            result:
              error instanceof Error
                ? "Child cleanup failed; reconcile execution before continuing."
                : "Unexpected child failure; reconciliation required.",
          });
          this.settled(child.id);
        },
      );
    }
  }
  private settled(id: string): void {
    this.active.delete(id);
    this.pump();
  }
  async close(): Promise<void> {
    this.abort.abort();
    await Promise.allSettled(this.active.values());
    if (this.failures.length)
      throw new AggregateError(this.failures, "Child execution cleanup failed");
  }
}
