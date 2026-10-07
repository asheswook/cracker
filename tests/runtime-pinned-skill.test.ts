import { test, expect } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import ky from "ky";
import type { Response as ModelResponse } from "openai/resources/responses/responses";
import type { Assignment, DaemonEvent } from "../packages/protocol/index.ts";
import type { Provider } from "../packages/provider/index.ts";
import { Runtime } from "../services/daemon/runtime.ts";
import { Journal } from "../services/daemon/journal.ts";
import { TaskArtifacts } from "../services/daemon/artifacts.ts";
import { ToolExecutor } from "../services/daemon/tools.ts";
import { hashToken } from "../services/control/auth.ts";
class FinishedJournal extends Journal {
  readonly finished = Promise.withResolvers<void>();
  override finish(run: string) {
    super.finish(run);
    this.finished.resolve();
  }
}
for (const rejectCurrent of [false,true])
for (const recovered of [false, true])
  test(`pinned receipt ${rejectCurrent ? "rejection stops execution" : "acceptance precedes inference"} (${recovered ? "SQLite recovery" : "fresh"})`, async () => {
    const root = await mkdtemp(join(tmpdir(), "pinned-skill-")),
      now = new Date().toISOString(),
      id = crypto.randomUUID(),
      content = "Exact v1 procedure: sum input integers, show arithmetic.";
    const binding = {
      skill_id: id,
      revision: 1,
      name: "Pinned v1",
      content_hash: await hashToken(content),
    };
    const assignment: Assignment = {
      run_id: crypto.randomUUID(),
      task: {
        id: crypto.randomUUID(),
        conversation_id: crypto.randomUUID(),
        objective: "Test a specific version",
        state: "running",
        reason: null,
        created_at: now,
        updated_at: now,
      },
      messages: [],
      instructions: "",
      memory: [],
      skill_binding: binding,
    };
    const receipts: DaemonEvent[] = [];
    let boundLoads = 0,
      modelCalls = 0;
    const server = Bun.serve({
      port: 0,
      async fetch(request) {
        const path = new URL(request.url).pathname;
        if (path === "/v1/daemon/extensions") return Response.json({ skills: [], servers: [] });
        if (path === `/v1/daemon/extensions/bound/${assignment.run_id}`) {
          boundLoads++;
          return Response.json({ ...binding, content });
        }
        if (path === "/v1/daemon/events") {
          const event=(await request.json()) as DaemonEvent;
          receipts.push(event);
          if(event.kind==='skill_loaded'&&(event.run_id!==assignment.run_id||rejectCurrent))return Response.json({error:{code:'stale_run'}},{status:409});
          return Response.json({ accepted: true });
        }
        if (path === "/v1/daemon/poll")
          return Response.json({
            assignment: recovered ? null : assignment,
            commands: [],
            messages: [],
          });
        if (path.startsWith("/v1/daemon/resume/")) return Response.json({ assignment });
        return Response.json({ messages: [], accepted: true });
      },
    });
    const path = join(root, "journal.sqlite");
    if (recovered) {
      const http = ky.create({ prefixUrl: server.url.href, retry: 0 });
      const artifacts = await TaskArtifacts.create({
        http,
        runId: assignment.run_id,
        conversationId: assignment.task.conversation_id,
        root,
      });
      const prior = new Journal(path);
      prior.start(assignment.run_id);
      prior.checkpoint({
        version: 1,
        assignment,
        input: [
          {
            role: "system",
            content: JSON.stringify({
              kind: "pinned_skill_version",
              content: "STALE HEAD V2 MUST NOT LOAD",
            }),
          },
        ],
        cursor: 0,
        seenCallIds: [],
        artifacts: artifacts.checkpoint(),
        inputTokens: 1,
      });
      prior.close();
    }
    const journal = new FinishedJournal(path);
    const historical=crypto.randomUUID();
    journal.enqueue({kind:'skill_loaded',event_id:historical,run_id:crypto.randomUUID(),skill_id:id,revision:1,content_hash:binding.content_hash});
    let toolCalls=0;
    class GuardTools extends ToolExecutor { override async run():Promise<never>{toolCalls++;throw new Error('unexpected tool execution');} }

    const provider: Provider = {
      async respond(input) {
        modelCalls++;
        expect(
          receipts.some(
            (event) =>
              event.kind === "skill_loaded" &&
              event.revision === 1 &&
              event.content_hash === binding.content_hash,
          ),
        ).toBe(true);
        expect(JSON.stringify(input)).toContain(content);
        expect(JSON.stringify(input)).not.toContain("STALE HEAD V2");
        return {
          id: crypto.randomUUID(),
          object: "response",
          created_at: 0,
          output: rejectCurrent ? [{type:"function_call",call_id:"unexpected-call",name:"shell",arguments:JSON.stringify({command:"synthetic-never-executed"})}] : [
            {
              type: "message",
              id: "final",
              role: "assistant",
              status: "completed",
              content: [
                { type: "output_text", text: "Arithmetic result available.", annotations: [] },
              ],
            },
          ],
          output_text: "",
          model: "synthetic",
          error: null,
          incomplete_details: null,
          instructions: null,
          metadata: null,
          parallel_tool_calls: false,
          temperature: null,
          top_p: null,
          tool_choice: "auto",
          tools: [],
          status: "completed",
        } as ModelResponse;
      },
    };
    const runtime = new Runtime({
      controlUrl: server.url.href,
      token: "synthetic",
      journal,
      provider,
      tools: new GuardTools(),
      artifactRoot: root,
    });
    try {
      if (recovered) await runtime.recover();
      else await runtime.tick();
      await journal.finished.promise;
      await runtime.flush();
      expect(boundLoads).toBe(1);
      expect(modelCalls).toBe(rejectCurrent?0:1);
      expect(toolCalls).toBe(0);
      expect(receipts.filter((e) => e.kind === "skill_loaded"&&e.run_id===assignment.run_id)).toHaveLength(1);
      expect(journal.rejected().some(({event})=>event.event_id===historical)).toBe(true);
      expect(journal.rejected().some(({event})=>event.kind==='skill_loaded'&&event.run_id===assignment.run_id)).toBe(rejectCurrent);
      console.log(
        JSON.stringify({ recovered, rejectCurrent, boundLoads, modelCalls,toolCalls,historicalDiscarded:true }),
      );
    } finally {
      await runtime.stop();
      journal.close();
      await server.stop(true);
      await rm(root, { recursive: true });
    }
  });
