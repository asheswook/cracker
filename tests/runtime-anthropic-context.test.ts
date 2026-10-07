import { expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { z } from "zod";
import { fixture, message, wire, summaryBlock } from "./anthropic-context-fixture.ts";
import { DaemonEvent, type Assignment, type Message } from "../packages/protocol/index.ts";
import { ComposingRequest } from "../packages/protocol/composing.ts";
import { Runtime } from "../services/daemon/runtime.ts";
import { Journal } from "../services/daemon/journal.ts";
import { RunCheckpoint } from "../services/daemon/active-context.ts";
import { ToolExecutor } from "../services/daemon/tools.ts";
const captureData = (index: number) =>
  `data:image/png;base64,${Buffer.from(`fixture-frame-${index}`).toString("base64")}`;

class ObservedJournal extends Journal {
  readonly done = Promise.withResolvers<void>();
  override finish(run: string): void {
    super.finish(run);
    this.done.resolve();
  }
}
class CaptureTools extends ToolExecutor {
  calls = 0;
  override async run() {
    return { text: "captured", images: [captureData(++this.calls)] };
  }
}

for (const mode of [
  "success",
  "failure",
  "cancel",
  "restart",
  "archived_restart",
  "changed_tools",
  "changed_policy",
] as const)
  test(`native runtime ${mode} preserves checkpoint, steering receipts and media provenance`, async () => {
    // Given a real SDK, local HTTP servers and a durable SQLite journal.
    const root = await mkdtemp(join(tmpdir(), "claude-native-")),
      path = join(root, "journal.sqlite");
    const now = new Date().toISOString();
    const assignment: Assignment = {
      run_id: crypto.randomUUID(),
      task: {
        id: crypto.randomUUID(),
        conversation_id: crypto.randomUUID(),
        objective: "fixture",
        state: "running",
        reason: null,
        created_at: now,
        updated_at: now,
      },
      messages: [],
      instructions: "",
      memory: [],
    };
    const source: Message = {
      id: crypto.randomUUID(),
      conversation_id: assignment.task.conversation_id,
      role: "user",
      content: "fixture original",
      sequence: 1,
      created_at: now,
      client_message_id: null,
    };
    assignment.messages.push(source);
    const steering: Message = {
      ...source,
      id: crypto.randomUUID(),
      content: "fixture steering",
      sequence: 2,
    };
    const entered = Promise.withResolvers<void>(),
      release = Promise.withResolvers<void>();
    const events: DaemonEvent[] = [],
      composing: string[][] = [],
      failures: string[] = [];
    let queued = false,
      assigned = false,
      resumed = false,
      infer = 0,
      compact = 0;
    const skillId = crypto.randomUUID();
    const skill = {
      id: skillId,
      vm_id: crypto.randomUUID(),
      name: "fixture",
      description: "fixture",
      enabled: true,
      revision: 1,
      observed_revision: 1,
      state: "ready",
      tool_count: 0,
      error_code: null,
      observed_at: now,
      updated_at: now,
    };
    const control = Bun.serve({
      hostname: "127.0.0.1",
      port: 0,
      async fetch(request) {
        const url = new URL(request.url);
        if (url.pathname === "/v1/daemon/extensions")
          return Response.json({
            skills: [{ ...skill, revision: resumed ? 2 : 1 }],
            servers:
              resumed && mode === "changed_tools"
                ? [
                    {
                      ...skill,
                      id: crypto.randomUUID(),
                      config: {
                        transport: "stdio",
                        command: process.execPath,
                        args: [join(process.cwd(), "tests/mcp-extension-fixture.ts")],
                      },
                      secret_keys: [],
                      secrets: {},
                    },
                  ]
                : [],
          });
        if (url.pathname === "/v1/daemon/poll") {
          const next = assigned ? null : assignment;
          assigned = true;
          return Response.json({ assignment: next, commands: [], messages: [] });
        }
        if (url.pathname.startsWith("/v1/daemon/resume/"))
          return Response.json({
            assignment:
              mode === "changed_policy"
                ? { ...assignment, instructions: "updated fixture policy" }
                : assignment,
          });
        if (url.pathname === "/v1/daemon/events") {
          events.push(DaemonEvent.parse(await request.json()));
          return Response.json({ accepted: true });
        }
        if (url.pathname === "/v1/daemon/composing") {
          const event = ComposingRequest.parse(await request.json());
          if (event.kind === "begin") composing.push(event.input_message_ids);
          return Response.json({ generation: 1 });
        }
        return Response.json({
          messages: queued && Number(url.searchParams.get("after")) < 2 ? [steering] : [],
        });
      },
    });
    const f = fixture({
      respond: async (body) => {
        if (body.compaction) {
          compact++;
          if (compact === (mode==="archived_restart"?3:1)) {
            entered.resolve();
            await release.promise;
          }
          return new Response(
            wire(
              message(
                mode === "failure" ? [{ ...summaryBlock, signature: "" }] : [summaryBlock],
                "compaction",
              ),
            ),
            { headers: { "content-type": "text/event-stream" } },
          );
        }
        infer++;
        const blocks =
          resumed || infer > 3
            ? [{ type: "text", text: "done" }]
            : [
                { type: "thinking", thinking: "fixture", signature: `thinking-${infer}` },
                {
                  type: "tool_use",
                  id: `capture-${infer}`,
                  name: "computer_exec",
                  input: { code: "await desktop.screenshot()", timeout_ms: 1000 },
                  caller: { type: "direct" },
                },
              ];
        return new Response(
          wire(message(blocks, resumed || infer > 3 ? "end_turn" : "tool_use", `msg-${infer}`)),
          { headers: { "content-type": "text/event-stream" } },
        );
      },
    });
    const journal = new ObservedJournal(path),
      tools = new CaptureTools();
    const runtime = new Runtime({
      controlUrl: control.url.href,
      token: "fixture",
      journal,
      provider: f.provider,
      tools,
      artifactRoot: root,
      compactThreshold: 64000,
      onFailure: (event) => failures.push(event.code),
    });
    let journalClosed = false;
    try {
      await runtime.tick();
      await entered.promise;
      const before = journal.recoverable(assignment.run_id);
      const completedCalls=mode==="archived_restart"?["capture-1","capture-2","capture-3"]:["capture-1"];
      expect(before?.seenCallIds).toEqual(completedCalls);
      expect(composing).toEqual(completedCalls.map(()=>[source.id]));
      if(mode==="archived_restart"){expect(before?.nativeContext?.archive?.through).toBeGreaterThan(0);expect(JSON.stringify(before?.input)).not.toContain(Buffer.from("fixture-frame-1").toString("base64"));}
      // When steering arrives during summarize, either commit or abort before continuation.
      queued = true;
      const shouldStop =
        mode === "cancel" ||
        mode === "restart" ||
        mode === "archived_restart" ||
        mode === "changed_tools" ||
        mode === "changed_policy";
      const stopping = shouldStop ? runtime.stop() : undefined;
      release.resolve();
      if (stopping) await stopping;
      else await journal.done.promise;
      await runtime.flush();
      // Then durable state advances atomically and no completed action is replayed.
      if (shouldStop) {
        expect(infer).toBe(completedCalls.length);
        expect(journal.recoverable(assignment.run_id)?.nativeContext).toEqual(
          before?.nativeContext,
        );
        expect(journal.recoverable(assignment.run_id)?.cursor).toBe(1);
        if (mode !== "cancel") {
          resumed = true;
          journal.close();
          journalClosed = true;
          const child = Bun.spawn(
            [
              process.execPath,
              "tests/runtime-anthropic-resume-fixture.ts",
              path,
              root,
              control.url.href,
              f.server.url.href,
              assignment.run_id,
            ],
            { stdout: "pipe", stderr: "pipe" },
          );
          const [exit, stdout, stderr] = await Promise.all([
            child.exited,
            new Response(child.stdout).text(),
            new Response(child.stderr).text(),
          ]);
          await Bun.write(
            `.omo/evidence/claude-native-context/runtime-${mode}-child.log`,
            JSON.stringify({ exit, stdout, stderr }, null, 2),
          );
          expect(exit).toBe(0);
          const result = z
            .object({ failures: z.array(z.string()), checkpoint: RunCheckpoint })
            .parse(JSON.parse(stdout.trim()));
          if (mode === "changed_tools" || mode === "changed_policy") {
            expect(result.failures).toEqual(["native_context_prefix_changed"]);
            expect(infer).toBe(1);
            expect(result.checkpoint.nativeContext).toEqual(before?.nativeContext);
          } else {
            expect(result.failures).toEqual([]);
            expect(result.checkpoint.cursor).toBe(2);
            expect(result.checkpoint.seenCallIds).toEqual(completedCalls);
            expect(composing.at(-1)).toEqual([source.id, steering.id]);
            const latest = f.requests.at(-1);
            if(mode!=="archived_restart")expect(f.requests.filter((request) => request.compaction).at(-1)?.messages).toEqual(f.requests[0]?.messages);
            else expect(result.checkpoint.nativeContext?.archive?.through).toBeGreaterThan(before?.nativeContext?.archive?.through??0);
            expect(latest?.system).toEqual(f.requests[0]?.system);
            expect(latest?.messages[0]?.content).toEqual([summaryBlock]);
            expect(latest?.messages[1]?.role).toBe("assistant");
            const systems = latest?.messages
              .filter((turn) => turn.role === "system")
              .flatMap((turn) =>
                z
                  .array(z.object({ type: z.literal("text"), text: z.string() }))
                  .parse(turn.content),
              );
            const catalogs = systems
              ?.filter((block) => block.text.startsWith('{"kind":"enabled_skill_catalog"'))
              .map((block) =>
                z
                  .object({ skills: z.array(z.object({ revision: z.number() })) })
                  .parse(JSON.parse(block.text)),
              );
            expect(catalogs?.at(-1)?.skills[0]?.revision).toBe(2);
          }
        }
      } else {
        expect(tools.calls).toBe(3);
        expect(
          events.filter(
            (event) => event.kind === "input_applied" && event.message_id === steering.id,
          ),
        ).toHaveLength(1);
        expect(
          composing.slice(1).every((ids) => ids.includes(source.id) && ids.includes(steering.id)),
        ).toBe(true);
        const originalImages=journal.originalInput(assignment.run_id).flatMap(item=>"content" in item&&Array.isArray(item.content)?item.content.flatMap(part=>part.type==="input_image"?[part.image_url]:[]):[]);
        expect(originalImages).toEqual([captureData(1),captureData(2),captureData(3)]);
        expect(journal.recoverable(assignment.run_id)?.toolImageIndexes?.length).toBeLessThanOrEqual(3);
        expect(journal.recoverable(assignment.run_id)?.seenCallIds).toEqual([
          "capture-1",
          "capture-2",
          "capture-3",
        ]);
        expect(
          journal.observations
            .forRun(assignment.run_id)
            .map((observation) => ({ action: observation.action_id, frames: observation.frames })),
        ).toEqual(
          [1, 2, 3].map((index) => ({
            action: `${assignment.run_id}:capture-${index}`,
            frames: [
              {
                sha256: new Bun.CryptoHasher("sha256").update(captureData(index)).digest("hex"),
                encoded_bytes: Buffer.byteLength(captureData(index)),
              },
            ],
          })),
        );
        expect(events.some((event) => event.kind === "state" && event.state === "succeeded")).toBe(
          true,
        );
        expect(failures.every((code) => code === "context_compaction_failed")).toBe(true);
        if (mode === "success") {
          expect(failures).toEqual([]);
          expect(JSON.stringify(f.requests.at(-1))).not.toContain(
            Buffer.from("fixture-frame-1").toString("base64"),
          );
          expect(JSON.stringify(f.requests.at(-1))).toContain(
            Buffer.from("fixture-frame-3").toString("base64"),
          );
        }
      }
      await Bun.write(
        `.omo/evidence/claude-native-context/runtime-${mode}.json`,
        JSON.stringify(
          {
            mode,
            failures,
            infer,
            compact,
            tools: tools.calls,
            composing,
            events,
            requests: f.requests,
            counts: f.counts,
            checkpoint: journalClosed ? null : journal.recoverable(assignment.run_id),
          },
          null,
          2,
        ),
      );
    } finally {
      release.resolve();
      if (!journalClosed) {
        await runtime.stop();
        journal.close();
      }
      f.provider.close();
      await f.close();
      await control.stop(true);
      await rm(root, { recursive: true, force: true });
    }
  }, 15000);
