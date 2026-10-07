import { expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import ky from "ky";
import type { Response as ModelResponse } from "openai/resources/responses/responses";
import { DaemonPoll } from "../packages/protocol";
import { controlFixture } from "./control-fixture";
import { Journal } from "../services/daemon/journal";
import { Runtime } from "../services/daemon/runtime";
import { ToolExecutor } from "../services/daemon/tools";
import { TaskArtifacts } from "../services/daemon/artifacts";

const fixture = controlFixture();
for (const uncertain of [false, true]) test(`disconnect follow-ups consume cancellation without replay; uncertain=${uncertain}`, async () => {
  await fixture.finishActive();
  const initial = await fixture.newTask();
  const { assignment } = DaemonPoll.parse(await (await fixture.request("/v1/daemon/poll", fixture.machine)).json());
  if (!assignment) throw new TypeError("Expected assignment");
  await fixture.request("/v1/daemon/events", fixture.machine, { kind: "input_applied", event_id: crypto.randomUUID(), run_id: assignment.run_id, message_id: initial.message.id });
  await fixture.request("/v1/daemon/events", fixture.machine, { kind: "state", event_id: crypto.randomUUID(), run_id: assignment.run_id, state: "unknown", reason: "Control disconnected during execution; reconcile interrupted effects before resuming" });
  const followups = ["내 캘린더에도 추가좀", "예약했어?", "예약은 안해도됨"];
  for (const content of followups) await fixture.request(`/v1/conversations/${initial.task.conversation_id}/messages`, fixture.client, { client_message_id: crypto.randomUUID(), content });
  const root = await mkdtemp(join(tmpdir(), "disconnect-followup-"));
  const server = Bun.serve({ port: 0, fetch: fixture.app.fetch });
  const journal = new Journal(join(root, "journal.sqlite"));
  const artifacts = await TaskArtifacts.create({ http: ky.create({ prefixUrl: server.url.href, headers: { Authorization: `Bearer ${fixture.machine}` } }), runId: assignment.run_id, conversationId: initial.task.conversation_id, root });
  journal.start(assignment.run_id);
  journal.begin(assignment.run_id, "historic-reservation");
  journal.complete("historic-reservation", "reservation accepted id=fixture-123");
  journal.checkpoint({ version: 1, assignment, input: [
    { role: "user", content: "Book a meeting room" },
    { type: "function_call", call_id: "historic-reservation", name: "shell", arguments: '{"command":"must not replay"}' },
    { type: "function_call_output", call_id: "historic-reservation", output: "reservation accepted id=fixture-123" },
  ], cursor: initial.message.sequence, seenCallIds: ["historic-reservation"], artifacts: artifacts.checkpoint(), inputTokens: 0 });
  if (uncertain) journal.begin(assignment.run_id, "unfinished-effect");
  journal.finish(assignment.run_id);
  let inference = 0, toolCalls = 0;
  class NoReplayTools extends ToolExecutor {
    override async run(): Promise<{ text: string }> { toolCalls++; throw new TypeError("No reservation replay permitted"); }
  }
  const completed = Promise.withResolvers<void>();
  const runtime = new Runtime({ controlUrl: server.url.href, token: fixture.machine, journal, tools: new NoReplayTools(), artifactRoot: root, provider: { respond: async input => {
    inference++;
    const text = JSON.stringify(input);
    expect(text).toContain("reservation accepted id=fixture-123");
    for (const content of followups) expect(text).toContain(content);
    expect(text.lastIndexOf(followups[2] ?? "")).toBeGreaterThan(text.lastIndexOf(followups[0] ?? ""));
    completed.resolve();
    return { id: "fixture-final", object: "response", created_at: 0, output: [{ type: "message", id: "final", role: "assistant", status: "completed", content: [{ type: "output_text", text: "Latest instruction received; no new booking.", annotations: [] }] }], output_text: "", model: "fixture", error: null, incomplete_details: null, instructions: null, metadata: null, parallel_tool_calls: false, temperature: null, top_p: null, tool_choice: "auto", tools: [], status: "completed" } satisfies ModelResponse;
  } } });
  try {
    await runtime.tick();
    if (!uncertain) {
      await Promise.race([completed.promise, Bun.sleep(2000).then(() => { throw new TypeError("Follow-ups never reached provider"); })]);
      for (let i = 0; i < 100 && journal.interrupted().length; i++) await Bun.sleep(10);
      await runtime.flush();
      const page = await (await fixture.request(`/v1/conversations/${initial.task.conversation_id}/messages`)).json();
      expect(page.messages.filter((m: {role:string;read_at:string|null}) => m.role === "user").every((m: {read_at:string|null}) => m.read_at !== null)).toBe(true);
    }
    expect(inference).toBe(uncertain ? 0 : 1);
    expect(toolCalls).toBe(0);
  } finally { await runtime.stop(); journal.close(); await server.stop(true); await rm(root, { recursive: true, force: true }); }
});
