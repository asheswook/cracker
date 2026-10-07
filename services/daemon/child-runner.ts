import { mkdir } from "node:fs/promises";
import { planResponse } from "../../packages/provider/response-plan.ts";
import type { Provider, ResponseInputItem, Tool } from "../../packages/provider/index.ts";
import { compactedServerWindow, contextBudget, compactContext } from "./active-context.ts";
import type { Child, DelegationJournal } from "./delegation-journal.ts";
import { ToolScheduler, scheduledBatch, type ToolAccess } from "./tool-scheduler.ts";
import { ToolExecutor, type ToolResult } from "./tools.ts";
export type ChildEnvironment = {
  readonly provider: Provider;
  readonly journal: DelegationJournal;
  readonly scheduler: ToolScheduler;
  readonly shared: ToolExecutor;
  readonly signal: AbortSignal;
  readonly beforeAction: () => Promise<void>;
};
export async function runChild(initial: Child, environment: ChildEnvironment): Promise<void> {
  const { journal, signal, provider, scheduler, shared } = environment,
    local = new ToolExecutor();
  let child = initial,
    input: ResponseInputItem[] = [...child.input];
  const seen = new Set(child.calls);
  let outcome:
    | {
        readonly state: "queued" | "succeeded" | "failed" | "unknown";
        readonly result: string | null;
      }
    | undefined;
  const finish = (state: "queued" | "succeeded" | "failed" | "unknown", result: string | null) => {
    outcome = { state, result };
    journal.save({ ...child, input, state: "finishing", result, consumed: false });
  };
  const tools: Tool[] = shared.definitions.filter(
    (tool) => tool.type === "function" && (tool.name === "shell" || shared.isMcp(tool.name)),
  );
  const save = () => {
    child = {
      ...child,
      input,
      calls: [...seen],
      mailbox: journal.get(child.id)?.mailbox ?? child.mailbox,
    };
    journal.checkpoint(child);
  };
  const mailbox = () => {
    const latest = journal.get(child.id);
    if (!latest) return;
    const applied = new Set(child.appliedMessages);
    for (const message of latest.mailbox)
      if (!applied.has(message.id)) input.push({ role: "user", content: message.text });
    child = {
      ...child,
      mailbox: latest.mailbox,
      appliedMessages: latest.mailbox.map((message) => message.id),
    };
  };
  try {
    await mkdir(child.directory, { recursive: true });
    local.setWorkspace(child.directory);
    child = { ...child, state: "running", consumed: false };
    journal.save(child);
    for (; child.turns < 64; child = { ...child, turns: child.turns + 1 }) {
      signal.throwIfAborted();
      await environment.beforeAction();
      mailbox();
      save();
      if (contextBudget(input, 0) > 64000) {
        if (provider.compact && provider.standaloneCompaction !== false)
          input = await compactContext(provider, { input, signal });
        else throw new RangeError("Child context budget exceeded");
      }
      const response = await provider.respond(input, tools, signal);
      signal.throwIfAborted();
      const plan = planResponse(response, tools, seen),
        start = input.length;
      if (plan.kind === "refusal") {
        finish("failed", plan.text);
        return;
      }
      for (const output of response.output)
        if (
          output.type === "message" ||
          output.type === "function_call" ||
          output.type === "reasoning" ||
          output.type === "compaction"
        )
          input.push(output);
      if (plan.kind === "final") {
        const latest = journal.get(child.id);
        if (latest && latest.mailbox.length > child.mailbox.length) {
          mailbox();
          continue;
        }
        const result = response.output
          .flatMap((item) =>
            item.type === "message"
              ? item.content.flatMap((part) => (part.type === "output_text" ? [part.text] : []))
              : [],
          )
          .join("\n");
        save();
        finish("succeeded", result);
        return;
      }
      const calls = response.output.filter((item) => item.type === "function_call");
      const results = await scheduledBatch(
        calls,
        (item, signal) => {
          const access: ToolAccess = shared.parallelRead(item.name) ? "read" : "exclusive";
          return scheduler.run(access, signal, async () => {
            await environment.beforeAction();
            signal.throwIfAborted();
            if ((journal.get(child.id)?.mailbox.length ?? 0) > child.mailbox.length)
              return {
                text: "Skipped: new steering arrived. Read the updated context before acting.",
              };
            const action = `${child.id}:${item.call_id}`;
            journal.begin(child.id, action);
            const result: ToolResult = await (shared.isMcp(item.name) ? shared : local).run(
              item.name,
              item.arguments,
              signal,
            );
            journal.complete(action, result.text);
            return result;
          });
        },
        signal,
      );
      for (const [index, item] of calls.entries()) {
        const result = results[index];
        if (!result) throw new TypeError("Missing child result");
        seen.add(item.call_id);
        input.push({ type: "function_call_output", call_id: item.call_id, output: result.text });
      }
      input = compactedServerWindow(input, start);
      save();
    }
    finish(
      "failed",
      "Child reached the 64-turn limit; inspect its findings before assigning narrower follow-up.",
    );
  } catch (error) {
    if (!(error instanceof Error) && !signal.aborted) throw error;
    journal.recoverChild(child.id);
    const current = journal.get(child.id);
    if (current) {
      child = current;
      finish(
        current.state === "unknown" ? "unknown" : signal.aborted ? "queued" : "failed",
        current.state === "unknown"
          ? current.result
          : signal.aborted
            ? null
            : "Child provider or tool failed; completed results were preserved.",
      );
    }
  } finally {
    await local.close();
    if (outcome) {
      const current = journal.get(child.id);
      if (!current) throw new TypeError("Unknown child after cleanup");
      const pendingMessage = current.mailbox.some(
        (message) => !current.appliedMessages.includes(message.id),
      );
      const resume = outcome.state !== "unknown" && pendingMessage;
      journal.save({
        ...current,
        state: resume ? "queued" : outcome.state,
        result: resume ? null : outcome.result,
        ...(resume ? { turns: 0 } : {}),
      });
    }
  }
}
