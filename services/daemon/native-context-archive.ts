import type { Database } from "bun:sqlite";
import { z } from "zod";
import { RunCheckpoint } from "./active-context.ts";
import { completeToolBoundary, TranscriptItem } from "../../packages/provider/compaction.ts";
import { nativeHash } from "../../packages/provider/anthropic-context-frames.ts";
import type { NativeContextState } from "../../packages/provider/native-context.ts";
import type { ResponseInputItem } from "../../packages/provider/index.ts";

export class NativeArchiveError extends Error {
  constructor(
    readonly code:
      | "archive_incomplete"
      | "archive_stale_checkpoint"
      | "archive_invalid_cut"
      | "archive_corrupt",
  ) {
    super(code);
    this.name = "NativeArchiveError";
  }
}
const Metadata = z.object({
  start_index: z.number().int().nonnegative(),
  end_index: z.number().int().positive(),
  payload_hash: z.string(),
  previous_hash: z.string(),
  chain_hash: z.string(),
  bytes: z.number().int().positive(),
});
const Row = Metadata.extend({ payload: z.string() });
const digest = (text: string) => new Bun.CryptoHasher("sha256").update(text).digest("hex");

function rebase(value: RunCheckpoint, head: { through: number; hash: string }): RunCheckpoint {
  const state = value.nativeContext;
  if (!state) throw new NativeArchiveError("archive_invalid_cut");
  const cut = state.compactedThrough;
  const shiftReply = (reply: NonNullable<NativeContextState["reply"]>) => {
    if (reply.from < cut) throw new NativeArchiveError("archive_invalid_cut");
    return { ...reply, from: reply.from - cut, to: reply.to - cut };
  };
  const frames = state.frames.map((frame) => {
    if (frame.from < cut) throw new NativeArchiveError("archive_invalid_cut");
    return {
      ...frame,
      from: frame.from - cut,
      to: frame.to - cut,
      ...(frame.reply ? { reply: shiftReply(frame.reply) } : {}),
    };
  });
  return {
    ...value,
    input: value.input.slice(cut),
    toolImageIndexes: (value.toolImageIndexes ?? [])
      .filter((index) => index >= cut)
      .map((index) => index - cut),
    nativeContext: {
      ...state,
      archive: head,
      compactedThrough: 0,
      frames,
      ...(state.reply ? { reply: shiftReply(state.reply) } : {}),
    },
  };
}

export class NativeContextArchive {
  constructor(private readonly db: Database) {
    db.exec(
      "CREATE TABLE IF NOT EXISTS native_context_archive(run TEXT NOT NULL,start_index INTEGER NOT NULL,end_index INTEGER NOT NULL,payload TEXT NOT NULL,payload_hash TEXT NOT NULL,previous_hash TEXT NOT NULL,chain_hash TEXT NOT NULL,bytes INTEGER NOT NULL,PRIMARY KEY(run,start_index))",
    );
  }
  assertHead(value: RunCheckpoint): void {
    const rows = z
      .array(Metadata)
      .parse(
        this.db
          .query(
            "SELECT start_index,end_index,payload_hash,previous_hash,chain_hash,bytes FROM native_context_archive WHERE run=? ORDER BY start_index",
          )
          .all(value.assignment.run_id),
      );
    let through = 0,
      hash = "";
    for (const row of rows) {
      if (
        row.start_index !== through ||
        row.end_index <= through ||
        row.previous_hash !== hash ||
        row.chain_hash !==
          nativeHash([hash, row.start_index, row.end_index, row.payload_hash, row.bytes])
      )
        throw new NativeArchiveError("archive_incomplete");
      through = row.end_index;
      hash = row.chain_hash;
    }
    const head = value.nativeContext?.archive;
    if (through !== (head?.through ?? 0) || hash !== (head?.hash ?? ""))
      throw new NativeArchiveError("archive_incomplete");
  }
  validHead(value: RunCheckpoint): boolean {
    try {
      this.assertHead(value);
      return true;
    } catch (error) {
      if (error instanceof NativeArchiveError || error instanceof z.ZodError) return false;
      throw error;
    }
  }
  commit(
    value: RunCheckpoint,
    signal: AbortSignal,
    write: (value: RunCheckpoint) => void,
  ): RunCheckpoint {
    signal.throwIfAborted();
    const candidate = RunCheckpoint.parse(value),
      state = candidate.nativeContext;
    if (
      !state?.summary ||
      state.compactedThrough < 1 ||
      state.compactedThrough > candidate.input.length
    )
      throw new NativeArchiveError("archive_invalid_cut");
    const prefix = candidate.input.slice(0, state.compactedThrough);
    if (!completeToolBoundary(prefix)) throw new NativeArchiveError("archive_invalid_cut");
    const payload = JSON.stringify(prefix),
      payloadHash = digest(payload),
      bytes = Buffer.byteLength(payload, "utf8");
    const start = state.archive?.through ?? 0,
      end = start + prefix.length,
      previous = state.archive?.hash ?? "";
    const chain = nativeHash([previous, start, end, payloadHash, bytes]);
    const next = RunCheckpoint.parse(rebase(candidate, { through: end, hash: chain }));
    return this.db
      .transaction(() => {
        const stored = z
          .object({ payload: z.string() })
          .nullable()
          .parse(
            this.db
              .query(
                "SELECT payload FROM checkpoints c WHERE c.run=? AND NOT EXISTS(SELECT 1 FROM actions a WHERE a.run=c.run AND (a.rowid>c.watermark OR a.state<>'completed'))",
              )
              .get(candidate.assignment.run_id),
          );
        if (!stored) throw new NativeArchiveError("archive_stale_checkpoint");
        const current = RunCheckpoint.parse(JSON.parse(stored.payload));
        this.assertHead(current);
        const existing = Row.nullable().parse(
          this.db
            .query("SELECT * FROM native_context_archive WHERE run=? AND start_index=?")
            .get(candidate.assignment.run_id, start),
        );
        if (existing) {
          if (
            existing.chain_hash !== chain ||
            existing.payload !== payload ||
            JSON.stringify(current) !== JSON.stringify(next)
          )
            throw new NativeArchiveError("archive_stale_checkpoint");
          signal.throwIfAborted();
          return current;
        }
        const unchanged = {
          ...candidate,
          nativeContext: current.nativeContext,
          inputTokens: current.inputTokens,
        };
        if (JSON.stringify(RunCheckpoint.parse(unchanged)) !== JSON.stringify(current))
          throw new NativeArchiveError("archive_stale_checkpoint");
        this.db
          .query("INSERT INTO native_context_archive VALUES(?,?,?,?,?,?,?,?)")
          .run(
            candidate.assignment.run_id,
            start,
            end,
            payload,
            payloadHash,
            previous,
            chain,
            bytes,
          );
        signal.throwIfAborted();
        write(next);
        signal.throwIfAborted();
        return next;
      })
      .immediate();
  }
  originalInput(run: string): ResponseInputItem[] {
    return this.db.transaction(() => {
      const stored = z
        .object({ payload: z.string() })
        .nullable()
        .parse(this.db.query("SELECT payload FROM checkpoints WHERE run=?").get(run));
      if (!stored) throw new NativeArchiveError("archive_incomplete");
      const current = RunCheckpoint.parse(JSON.parse(stored.payload));
      this.assertHead(current);
      const original: ResponseInputItem[] = [];
      const indexes = z
        .array(z.object({ start_index: z.number() }))
        .parse(
          this.db
            .query(
              "SELECT start_index FROM native_context_archive WHERE run=? ORDER BY start_index",
            )
            .all(run),
        );
      for (const index of indexes) {
        const row = Row.parse(
          this.db
            .query("SELECT * FROM native_context_archive WHERE run=? AND start_index=?")
            .get(run, index.start_index),
        );
        if (
          digest(row.payload) !== row.payload_hash ||
          Buffer.byteLength(row.payload) !== row.bytes
        )
          throw new NativeArchiveError("archive_corrupt");
        const items = z.array(TranscriptItem).parse(JSON.parse(row.payload));
        if (items.length !== row.end_index - row.start_index)
          throw new NativeArchiveError("archive_corrupt");
        for (const item of items) original.push(item);
      }
      return [...original, ...current.input];
    })();
  }
}
