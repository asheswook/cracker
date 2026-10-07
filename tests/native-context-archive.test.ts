import { expect, test } from "bun:test";
import { Database } from "bun:sqlite";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { z } from "zod";
import { Journal } from "../services/daemon/journal.ts";
import type { RunCheckpoint } from "../services/daemon/active-context.ts";
import {
  nativeHash,
  prepareNative,
  nativeMessages,
} from "../packages/provider/anthropic-context-frames.ts";
import { nativeMessageBody } from "../packages/provider/anthropic-context-wire.ts";
import {
  fixture,
  addReply,
  model,
  message,
  wire,
  summaryBlock,
} from "./anthropic-context-fixture.ts";
import type { NativeContextState } from "../packages/provider/native-context.ts";
import type { ResponseInputItem } from "../packages/provider/index.ts";

function checkpoint(
  run: string,
  input: ResponseInputItem[],
  state: NativeContextState,
): RunCheckpoint {
  const now = "2026-10-03T00:00:00Z";
  return {
    version: 1,
    assignment: {
      run_id: run,
      task: {
        id: crypto.randomUUID(),
        conversation_id: crypto.randomUUID(),
        objective: "fixture",
        state: "running",
        reason: null,
        created_at: now,
        updated_at: now,
      },
      instructions: "",
      messages: [],
      memory: [],
    },
    input,
    cursor: 1,
    seenCallIds: [],
    toolImageIndexes: input.flatMap((item, index) =>
      "content" in item &&
      Array.isArray(item.content) &&
      item.content.some((part) => part.type === "input_image")
        ? [index]
        : [],
    ),
    artifacts: { directory: "fixture", seen: [], inlineBytes: 0 },
    inputTokens: 70000,
    nativeContext: state,
    appliedInputIds: [crypto.randomUUID()],
  };
}
async function setup() {
  const root = await mkdtemp(join(tmpdir(), "native-archive-")),
    path = join(root, "journal.sqlite"),
    run = crypto.randomUUID();
  const f = fixture({
      respond: (body) =>
        new Response(
          wire(
            message(
              body.compaction
                ? [summaryBlock]
                : [
                    {
                      type: "thinking",
                      thinking: "",
                      signature: "signed-fixture",
                      future: { opaque: true },
                    },
                    { type: "text", text: "done", citations: null },
                  ],
              body.compaction ? "compaction" : "end_turn",
            ),
          ),
          { headers: { "content-type": "text/event-stream" } },
        ),
    }),
    journal = new Journal(path),
    db = new Database(path);
  journal.start(run);
  const input: ResponseInputItem[] = [
    { role: "system", content: "fixture policy" },
    { role: "user", content: "original" },
  ];
  const first = await f.provider.nativeContext.respond({
    runId: run,
    input,
    tools: [],
    signal: new AbortController().signal,
    clock: "first",
  });
  addReply(input, first.response.output);
  input.push({ role: "user", content: "next" });
  const current = checkpoint(run, input, first.state);
  journal.checkpoint(current);
  const compacted = await f.provider.nativeContext.compact({
    runId: run,
    input,
    tools: [],
    state: first.state,
    signal: new AbortController().signal,
  });
  if (!compacted) throw new TypeError("no summary");
  const candidate = { ...current, inputTokens: 0, nativeContext: compacted };
  return {
    root,
    path,
    run,
    f,
    journal,
    db,
    current,
    candidate,
    close: async () => {
      journal.close();
      db.close();
      await f.close();
      await rm(root, { recursive: true, force: true });
    },
  };
}
test("policy precedence survives repeated compaction, archive and process restart", async () => {
  const s = await setup();
  let input = s.current.input,
    state = s.current.nativeContext;
  const revisions = (messages: unknown): number[] => {
    const parsed = z.array(z.object({ role: z.string(), content: z.unknown() })).parse(messages);
    return parsed
      .filter((item) => item.role === "system")
      .flatMap((item) =>
        z
          .array(z.object({ text: z.string() }))
          .parse(item.content)
          .flatMap((block) => {
            if (!block.text.startsWith('{"policy_revision":')) return [];
            return [
              z.object({ policy_revision: z.number() }).parse(JSON.parse(block.text))
                .policy_revision,
            ];
          }),
      );
  };
  const reply = async (revision: number) => {
    if (!state) throw new TypeError("state missing");
    input.push({ role: "system", content: JSON.stringify({ policy_revision: revision }) });
    const result = await s.f.provider.nativeContext.respond({
      runId: s.run,
      input,
      tools: [],
      state,
      signal: new AbortController().signal,
      clock: "policy-clock",
    });
    expect(revisions(s.f.requests.at(-1)?.messages).at(-1)).toBe(revision);
    state = result.state;
    addReply(input, result.response.output);
    input.push({ role: "user", content: "continue" });
  };
  const evidence: unknown[] = [];
  try {
    await reply(2);
    await reply(3);
    expect(revisions(s.f.requests.at(-1)?.messages)).toEqual([2, 3]);
    for (const latest of [3, 4, 2]) {
      if (latest !== 3) {
        await reply(latest);
        await reply(latest);
      }
      if (!state) throw new TypeError("state missing");
      const last = state.frames.at(-1);
      if (!last) throw new TypeError("frame missing");
      const retained = nativeMessages(input, { ...state, summary: undefined, frames: [last] });
      const value = { ...s.current, input, nativeContext: state };
      s.journal.checkpoint(value);
      let compacted = await s.f.provider.nativeContext.compact({
        runId: s.run,
        input,
        tools: [],
        state,
        signal: new AbortController().signal,
      });
      if (!compacted) throw new TypeError("summary missing");
      expect(nativeMessages(input, compacted).slice(1)).toEqual(retained);
      const committed = s.journal.archiveCheckpoint(
        { ...value, nativeContext: compacted, inputTokens: 0 },
        new AbortController().signal,
      );
      input = committed.input;
      state = committed.nativeContext;
      const child = Bun.spawn(
        [
          process.execPath,
          "tests/native-archive-resume-fixture.ts",
          s.path,
          s.run,
          s.f.server.url.href,
        ],
        { stdout: "pipe", stderr: "pipe" },
      );
      const [stdout, stderr, exit] = await Promise.all([
        new Response(child.stdout).text(),
        new Response(child.stderr).text(),
        child.exited,
      ]);
      expect(exit).toBe(0);
      expect(stderr).toBe("");
      const sent = s.f.requests.at(-1)?.messages;
      expect(JSON.stringify(sent?.slice(1, 1 + retained.length))).toBe(JSON.stringify(retained));
      const order = revisions(sent);
      expect(order.at(-1)).toBe(latest);
      expect(order.slice(1)).toEqual(latest === 3 ? [2, 3] : latest === 4 ? [2, 3, 4] : [3, 4, 2]);
      evidence.push({ latest, order, retainedHash: nativeHash(retained), stdout });
      // A second compact before pending instructions are emitted must preserve their precedence.
      const recovered = s.journal.recoverable(s.run);
      if (!recovered?.nativeContext) throw new TypeError("recovery missing");
      compacted = await s.f.provider.nativeContext.compact({
        runId: s.run,
        input,
        tools: [],
        state: recovered.nativeContext,
        signal: new AbortController().signal,
      });
      if (!compacted) throw new TypeError("second summary missing");
      const again = s.journal.archiveCheckpoint(
        { ...recovered, nativeContext: compacted, inputTokens: 0 },
        new AbortController().signal,
      );
      input = again.input;
      state = again.nativeContext;
      if (!state) throw new TypeError("state missing");
      await s.f.provider.nativeContext.measure({
        runId: s.run,
        input,
        tools: [],
        state,
        signal: new AbortController().signal,
        clock: "pending-clock",
      });
      expect(revisions(s.f.counts.at(-1)?.messages)).toEqual(
        latest === 3 ? [2, 3] : latest === 4 ? [2, 3, 4] : [3, 4, 2],
      );
    }
    const original = s.journal
      .originalInput(s.run)
      .filter((item) => "role" in item && item.role === "system")
      .flatMap((item) =>
        "content" in item &&
        typeof item.content === "string" &&
        item.content.startsWith('{"policy_revision":')
          ? [JSON.parse(item.content).policy_revision]
          : [],
      );
    expect(original).toEqual([2, 3, 4, 4, 2, 2]);
    await Bun.write(
      ".omo/evidence/claude-bounded-context/policy-order-green.json",
      JSON.stringify(evidence, null, 2),
    );
  } finally {
    await s.close();
  }
});
for (const mode of ["commit", "rollback", "cancel", "uncertain", "uncheckpointed_effect"] as const)
  test(`native archive ${mode} atomically preserves original input and effect safety`, async () => {
    // Given a durable checkpoint and a valid signed replacement at a closed boundary.
    const s = await setup(),
      signal = new AbortController();
    try {
      if (mode === "rollback")
        s.db.exec(
          "CREATE TRIGGER fail_checkpoint BEFORE INSERT ON checkpoints BEGIN SELECT RAISE(ABORT,'fixture rollback'); END",
        );
      if (mode === "cancel") signal.abort();
      if (mode === "uncertain") s.journal.begin(s.run, `${s.run}:uncertain`);
      if (mode === "uncheckpointed_effect") {
        s.journal.begin(s.run, `${s.run}:external`);
        s.journal.complete(`${s.run}:external`, "completed before checkpoint");
      }
      // When the archive and rebased checkpoint commit together, or either operation fails.
      if (mode === "commit") {
        const after = s.journal.archiveCheckpoint(s.candidate, signal.signal);
        const repeated = s.journal.archiveCheckpoint(s.candidate, signal.signal);
        expect(repeated).toEqual(after);
        expect(s.journal.originalInput(s.run)).toEqual(s.current.input);
        expect(
          nativeMessages(after.input, after.nativeContext ?? s.candidate.nativeContext),
        ).toEqual(nativeMessages(s.candidate.input, s.candidate.nativeContext));
        expect(after.input.length).toBeLessThan(s.current.input.length);
        expect(s.db.query("SELECT count(*) AS n FROM native_context_archive").get()).toEqual({
          n: 1,
        });
      } else {
        expect(() => s.journal.archiveCheckpoint(s.candidate, signal.signal)).toThrow();
        // Then rollback/cancel preserve both the complete original and the old checkpoint.
        expect(s.db.query("SELECT count(*) AS n FROM native_context_archive").get()).toEqual({
          n: 0,
        });
        expect(s.journal.originalInput(s.run)).toEqual(s.current.input);
        if (mode === "uncertain" || mode === "uncheckpointed_effect")
          expect(s.journal.recoverable(s.run)).toBeNull();
        else expect(s.journal.recoverable(s.run)?.nativeContext).toEqual(s.current.nativeContext);
        if (mode === "rollback") {
          s.db.exec("DROP TRIGGER fail_checkpoint");
          const after = s.journal.archiveCheckpoint(s.candidate, new AbortController().signal);
          expect(after.nativeContext?.archive?.through).toBe(
            s.candidate.nativeContext.compactedThrough,
          );
        }
      }
      await Bun.write(
        `.omo/evidence/claude-bounded-context/archive-${mode}.json`,
        JSON.stringify(
          {
            mode,
            rows: s.db
              .query(
                "SELECT start_index,end_index,payload_hash,previous_hash,chain_hash,bytes FROM native_context_archive",
              )
              .all(),
            recoverable: s.journal.recoverable(s.run),
          },
          null,
          2,
        ),
      );
    } finally {
      await s.close();
    }
  });

test("archive continuity and payload integrity reject missing or corrupted original history", async () => {
  const s = await setup();
  try {
    s.journal.archiveCheckpoint(s.candidate, new AbortController().signal);
    s.db.query("UPDATE native_context_archive SET payload=?").run("[]");
    expect(() => s.journal.originalInput(s.run)).toThrow("archive_corrupt");
    s.db.exec("DELETE FROM native_context_archive");
    expect(s.journal.recoverable(s.run)).toBeNull();
  } finally {
    await s.close();
  }
});

test("process exit between archive insert and checkpoint write rolls back and retry succeeds", async () => {
  const s = await setup();
  try {
    const candidatePath = join(s.root, "candidate.json");
    await Bun.write(candidatePath, JSON.stringify(s.candidate));
    const child = Bun.spawn(
      [process.execPath, "tests/native-archive-crash-fixture.ts", s.path, candidatePath],
      { stdout: "pipe", stderr: "pipe" },
    );
    const [exit, stdout, stderr] = await Promise.all([
      child.exited,
      new Response(child.stdout).text(),
      new Response(child.stderr).text(),
    ]);
    expect(exit).toBe(73);
    expect(s.db.query("SELECT count(*) AS n FROM native_context_archive").get()).toEqual({ n: 0 });
    expect(s.journal.recoverable(s.run)?.nativeContext).toEqual(s.current.nativeContext);
    expect(s.journal.originalInput(s.run)).toEqual(s.current.input);
    const after = s.journal.archiveCheckpoint(s.candidate, new AbortController().signal);
    expect(s.journal.originalInput(s.run)).toEqual(s.current.input);
    expect(after.nativeContext?.archive?.through).toBe(s.candidate.nativeContext.compactedThrough);
    await Bun.write(
      ".omo/evidence/claude-bounded-context/archive-process-crash.json",
      JSON.stringify(
        {
          exit,
          stdout,
          stderr,
          restoredOriginalHash: nativeHash(s.journal.originalInput(s.run)),
          checkpoint: after,
        },
        null,
        2,
      ),
    );
  } finally {
    await s.close();
  }
});

test("105 capture turns keep active state bounded and preserve original history across a fresh process", async () => {
  // Given original media stays durable while only an exact signed suffix remains active.
  const s = await setup();
  let input = s.current.input,
    state = s.current.nativeContext;
  if (!state) throw new TypeError("missing state");
  const original = structuredClone(input),
    sizes: number[] = [];
  try {
    for (let index = 0; index < 105; index++) {
      const image: ResponseInputItem = {
        role: "user",
        content: [
          {
            type: "input_image",
            detail: "original",
            image_url: `data:image/png;base64,${Buffer.alloc(128 * 1024, index).toString("base64")}`,
          },
        ],
      };
      input.push(image);
      original.push(structuredClone(image));
      const result = await s.f.provider.nativeContext.respond({
        runId: s.run,
        input,
        tools: [],
        state,
        signal: new AbortController().signal,
        clock: `clock-${index}`,
      });
      state = result.state;
      addReply(input, result.response.output);
      addReply(original, structuredClone(result.response.output));
      const nextUser: ResponseInputItem = { role: "user", content: `next-${index}` };
      input.push(nextUser);
      original.push(structuredClone(nextUser));
      const value = {
        ...s.current,
        input,
        nativeContext: state,
        toolImageIndexes: input.flatMap((item, i) =>
          "content" in item &&
          Array.isArray(item.content) &&
          item.content.some((part) => part.type === "input_image")
            ? [i]
            : [],
        ),
      };
      s.journal.checkpoint(value);
      const summary = await s.f.provider.nativeContext.compact({
        runId: s.run,
        input,
        tools: [],
        state,
        signal: new AbortController().signal,
      });
      if (!summary) throw new TypeError("expected summary");
      const before = {
        runId: s.run,
        input,
        tools: [],
        state: summary,
        signal: new AbortController().signal,
        clock: "same-wire",
      };
      const expected = nativeHash(nativeMessageBody(before, prepareNative(before, model), 16384));
      const committed = s.journal.archiveCheckpoint(
        { ...value, inputTokens: 0, nativeContext: summary },
        new AbortController().signal,
      );
      input = committed.input;
      state = committed.nativeContext;
      if (!state) throw new TypeError("lost native state");
      const after = { ...before, input, state };
      expect(nativeHash(nativeMessageBody(after, prepareNative(after, model), 16384))).toBe(
        expected,
      );
      sizes.push(Buffer.byteLength(JSON.stringify(committed)));
    }
    // When reconstructing explicitly or restarting through a process that forbids archive hydration.
    const restored = s.journal.originalInput(s.run),
      head = s.journal.recoverable(s.run);
    expect(nativeHash(restored)).toBe(nativeHash(original));
    expect(Math.max(...sizes)).toBeLessThan(600000);
    const totals = z
      .object({ n: z.number(), bytes: z.number() })
      .parse(
        s.db.query("SELECT count(*) AS n,sum(bytes) AS bytes FROM native_context_archive").get(),
      );
    expect(totals.n).toBe(105);
    expect(totals.bytes).toBeLessThan(20_000_000);
    const child = Bun.spawn(
      [
        process.execPath,
        "tests/native-archive-resume-fixture.ts",
        s.path,
        s.run,
        s.f.server.url.href,
      ],
      { stdout: "pipe", stderr: "pipe" },
    );
    const [exit, stdout, stderr] = await Promise.all([
      child.exited,
      new Response(child.stdout).text(),
      new Response(child.stderr).text(),
    ]);
    // Then the new process only loads the bounded active state, and exact originals remain available.
    expect(exit).toBe(0);
    const childResult = z
      .object({ activeBytes: z.number(), inputHash: z.string() })
      .parse(JSON.parse(stdout));
    expect(childResult.activeBytes).toBeLessThan(600000);
    expect(childResult.inputHash).toBe(nativeHash(head?.input));
    await Bun.write(
      ".omo/evidence/claude-bounded-context/long-capture-restart.json",
      JSON.stringify(
        {
          turns: 105,
          maxActiveBytes: Math.max(...sizes),
          activeBytes: sizes,
          archive: totals,
          originalHash: nativeHash(original),
          reconstructedHash: nativeHash(restored),
          exit,
          stdout,
          stderr,
        },
        null,
        2,
      ),
    );
  } finally {
    await s.close();
  }
}, 30000);
