import type { Database } from "bun:sqlite";
import { z } from "zod";
import { TranscriptItem, completeToolBoundary } from "../../packages/provider/compaction.ts";

export const ChildState = z.enum([
  "queued",
  "running",
  "finishing",
  "succeeded",
  "failed",
  "unknown",
]);
export const Child = z.object({
  id: z.string(),
  parent: z.string(),
  task: z.string(),
  directory: z.string(),
  state: ChildState,
  input: z.array(TranscriptItem),
  calls: z.array(z.string()),
  result: z.string().nullable(),
  consumed: z.boolean(),
  turns: z.number().int().nonnegative(),
  mailbox: z.array(z.object({ id: z.string(), text: z.string() })),
  appliedMessages: z.array(z.string()),
});
export type Child = z.infer<typeof Child>;
export class DelegationJournal {
  constructor(private readonly db: Database) {
    db.exec(
      "CREATE TABLE IF NOT EXISTS child_agents(id TEXT PRIMARY KEY,parent TEXT NOT NULL,payload TEXT NOT NULL); CREATE TABLE IF NOT EXISTS child_effects(id TEXT PRIMARY KEY,child TEXT NOT NULL,state TEXT NOT NULL,result TEXT);",
    );
  }
  list(parent: string): Child[] {
    return z
      .array(z.object({ payload: z.string() }))
      .parse(
        this.db.query("SELECT payload FROM child_agents WHERE parent=? ORDER BY rowid").all(parent),
      )
      .map((row) => Child.parse(JSON.parse(row.payload)));
  }
  get(id: string): Child | undefined {
    const row = z
      .object({ payload: z.string() })
      .nullable()
      .parse(this.db.query("SELECT payload FROM child_agents WHERE id=?").get(id));
    return row ? Child.parse(JSON.parse(row.payload)) : undefined;
  }
  create(child: Child): Child {
    const existing = this.get(child.id);
    if (existing) {
      if (existing.parent !== child.parent || existing.task !== child.task)
        throw new TypeError("Child identity conflict");
      return existing;
    }
    this.db
      .query("INSERT INTO child_agents VALUES(?,?,?)")
      .run(child.id, child.parent, JSON.stringify(child));
    return child;
  }
  save(child: Child): void {
    this.db.transaction(() => {
      const current = this.get(child.id);
      if (!current) throw new TypeError("Unknown child");
      const mailbox = new Map(current.mailbox.map((message) => [message.id, message]));
      for (const message of child.mailbox)
        if (!mailbox.has(message.id)) mailbox.set(message.id, message);
      this.db
        .query("UPDATE child_agents SET payload=? WHERE id=?")
        .run(JSON.stringify({ ...child, mailbox: [...mailbox.values()] }), child.id);
    })();
  }
  message(id: string, message: { readonly id: string; readonly text: string }): void {
    const child = this.get(id);
    if (!child) throw new TypeError("Unknown child");
    if (child.mailbox.some((item) => item.id === message.id)) return;
    this.save({ ...child, mailbox: [...child.mailbox, message] });
  }
  begin(child: string, id: string): void {
    this.db.query("INSERT INTO child_effects VALUES(?,?,'started',NULL)").run(id, child);
  }
  complete(id: string, result: string): void {
    this.db.query("UPDATE child_effects SET state='completed',result=? WHERE id=?").run(result, id);
  }
  checkpoint(child: Child): void {
    if (!completeToolBoundary(child.input)) throw new TypeError("Incomplete child tool boundary");
    this.db.transaction(() => {
      this.save(child);
      this.db.query("DELETE FROM child_effects WHERE child=?").run(child.id);
    })();
  }
  recover(parent: string): void {
    for (const child of this.list(parent)) this.recoverChild(child.id);
  }
  recoverChild(id: string): void {
    const child = this.get(id);
    if (!child) return;
    if (child.state !== "running" && child.state !== "finishing") return;
    const effect = this.db
      .query("SELECT id FROM child_effects WHERE child=? LIMIT 1")
      .get(child.id);
    this.save({
      ...child,
      state: effect || child.state === "finishing" ? "unknown" : "queued",
      result:
        child.state === "finishing"
          ? "Child cleanup was interrupted; reconciliation is required before continuing."
          : effect
            ? "Interrupted tool effects require reconciliation; no actions were replayed."
            : null,
    });
  }
}
