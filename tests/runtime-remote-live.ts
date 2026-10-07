import { mkdtemp, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import ky, { HTTPError } from "ky";
import { z } from "zod";
import { Runtime } from "../services/daemon/runtime.ts";
import { Journal } from "../services/daemon/journal.ts";
import { ToolExecutor } from "../services/daemon/tools.ts";
import { OpenAIProvider, type Provider } from "../packages/provider/index.ts";
import { Task, Message } from "../packages/protocol/index.ts";
const Connection = z.object({ control_url: z.url(), workspace_id: z.uuid(), vm_id: z.uuid(), client_token: z.string(), vm_token: z.string() });
export async function remoteSmoke(): Promise<void> {
  const connection = Connection.parse(await Bun.file(".local/remote-connection.json").json());
  const mode = z.enum(["api", "chatgpt"]).parse(process.env["PROBE_MODE"]);
  const client = ky.create({ prefixUrl: connection.control_url, headers: { Authorization: `Bearer ${connection.client_token}` }, retry: 0, timeout: 15000 });
  const tasks = z.object({ tasks: z.array(Task) }).parse(await client.get("v1/tasks").json()).tasks;
  if (tasks.some(t => !["cancelled", "succeeded", "failed"].includes(t.state))) throw new TypeError("Workspace has unrelated active tasks; refusing to poll");
  const dir = await mkdtemp(join(tmpdir(), "assistant-remote-proof-"));
  const file = join(dir, "proof.txt"), marker = `RUNTIME_PROOF_${crypto.randomUUID()}`, preference = `orchid-${crypto.randomUUID()}`;
  const conversation = z.object({ conversation: z.object({ id: z.uuid() }) }).parse(await client.post("v1/conversations", { json: { title: `Runtime smoke ${mode}` } }).json()).conversation.id;
  const task = z.object({ task: Task }).parse(await client.post(`v1/conversations/${conversation}/messages`, { json: { client_message_id: crypto.randomUUID(), content: `Perform this harmless smoke test now. Use the shell tool to write exactly ${marker} without a newline into ${file}, then read the file back with the shell tool, and report the actual observed contents. Do not modify any other file. For this QA conversation only, remember that my preferred status label is ${preference}.` } }).json()).task;
  let observingFuture = false, memoryInjected = false;
  const underlying = new OpenAIProvider({ mode, model: "gpt-5.6-luna", ...(mode === "api" ? { apiKey: z.string().min(1).parse(process.env["OPENAI_API_KEY"]) } : { tokenFile: ".local/chatgpt.json" }) });
  const provider: Provider = { respond(input, tools, signal) {
    if (observingFuture) memoryInjected ||= input.some(item => "role" in item && item.role === "user" && "content" in item && typeof item.content === "string" && item.content.includes(preference));
    return underlying.respond(input, tools, signal);
  } };
  const journal = new Journal(join(dir, "journal.sqlite"));
  const runtime = new Runtime({ controlUrl: connection.control_url, token: connection.vm_token, journal, provider, tools: new ToolExecutor() });
  const began = Date.now();
  let succeeded = false, memoryStored = false;
  try {
    await runtime.recover();
    while (Date.now() - began < 150000) {
      await runtime.tick();
      const current = z.object({ tasks: z.array(Task) }).parse(await client.get("v1/tasks").json()).tasks.find(t => t.id === task.id);
      if (current?.state === "unknown" || current?.state === "failed") throw new TypeError(`Runtime task ${current.state}`);
      succeeded = current?.state === "succeeded";
      const memory = z.object({ memories: z.array(z.object({ text: z.string() })) }).parse(await client.get("v1/memory").json());
      memoryStored = memory.memories.some(m => m.text.includes(preference));
      if (succeeded && memoryStored) break;
      await Bun.sleep(500);
    }
    if (!succeeded || !memoryStored) throw new TypeError("Runtime or memory deadline exceeded");
    const content = await readFile(file, "utf8");
    if (content !== marker) throw new TypeError("Actual shell artifact mismatch");
    const messages = z.object({ messages: z.array(Message) }).parse(await client.get(`v1/conversations/${conversation}/messages`).json()).messages;
    if (!messages.some(m => m.role === "assistant" && m.content.includes(marker))) throw new TypeError("No durable observed-result reply");
    observingFuture = true;
    const followup = z.object({ task: Task }).parse(await client.post(`v1/conversations/${conversation}/messages`, { json: { client_message_id: crypto.randomUUID(), content: "What is my preferred status label for this QA conversation? Reply with the label only." } }).json()).task;
    let futureSucceeded = false;
    while (Date.now() - began < 210000) {
      await runtime.tick();
      const next = z.object({ tasks: z.array(Task) }).parse(await client.get("v1/tasks").json()).tasks.find(t => t.id === followup.id);
      if (next?.state === "unknown" || next?.state === "failed") throw new TypeError("Future task failed");
      futureSucceeded = next?.state === "succeeded";
      if (futureSucceeded) break;
      await Bun.sleep(500);
    }
    const futureMessages = z.object({ messages: z.array(Message) }).parse(await client.get(`v1/conversations/${conversation}/messages`).json()).messages;
    const finalReply = futureMessages.filter(m => m.role === "assistant").at(-1)?.content ?? "";
    if (!futureSucceeded || !memoryInjected || !finalReply.includes(preference)) throw new TypeError("Future context memory/reply missing");
    console.log(JSON.stringify({ verified_at: new Date().toISOString(), mode, model: "gpt-5.6-luna", surface: "macOS host smoke via deployed Cloudflare control + real PostgreSQL", task_id: task.id, conversation_id: conversation, succeeded, memory_stored: memoryStored, future_task_succeeded: futureSucceeded, memory_injected_into_future_context: memoryInjected, future_reply_contains_preference: true, shell_artifact: file, shell_content_matches: true, durable_reply_contains_observation: true, elapsed_ms: Date.now() - began }));
  } finally { await runtime.stop(); journal.close(); }
}
if (import.meta.main) {
  try { await remoteSmoke(); }
  catch (error) { console.error(JSON.stringify({ failed: true, error_type: error instanceof Error ? error.name : "unknown", code: error instanceof HTTPError ? error.response.status : "runtime_probe_failed" })); process.exitCode = 1; }
}
