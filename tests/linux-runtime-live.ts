import ky, { HTTPError } from "ky";
import { z } from "zod";
import { Message, Task } from "../packages/protocol/index.ts";
const Connection = z.object({ control_url: z.url(), client_token: z.string().min(1) });
const Schedule = z.object({ id: z.uuid(), conversation_id: z.uuid(), due_at: z.string(), status: z.enum(["pending", "delivered", "cancelled"]), source_message_id: z.uuid().nullable() });
class LinuxProbeError extends Error { constructor(readonly code: string) { super(code); this.name = "LinuxProbeError"; } }
async function probe(): Promise<void> {
  const computerProbe = process.env["PROBE_COMPUTER"] === "1";
  const mode = z.enum(["api", "chatgpt"]).parse(process.env["PROBE_MODE"]);
  const connection = Connection.parse(await Bun.file(".local/remote-connection.json").json());
  const client = ky.create({ prefixUrl: connection.control_url, headers: { Authorization: `Bearer ${connection.client_token}` }, retry: 0, timeout: 15000 });
  const tasks = async () => z.object({ tasks: z.array(Task) }).parse(await client.get("v1/tasks").json()).tasks;
  if ((await tasks()).some(t => !["succeeded", "failed", "cancelled"].includes(t.state))) throw new LinuxProbeError("unrelated_active_task");
  const conversation = z.object({ conversation: z.object({ id: z.uuid() }) }).parse(await client.post("v1/conversations", { json: { title: `Linux runtime acceptance ${mode}` } }).json()).conversation.id;
  const messages = async () => z.object({ messages: z.array(Message) }).parse(await client.get(`v1/conversations/${conversation}/messages`).json()).messages;
  const schedules = async () => z.object({ schedules: z.array(Schedule) }).parse(await client.get("v1/schedules").json()).schedules.filter(s => s.conversation_id === conversation);
  const post = async (content: string) => z.object({ task: Task, message: Message }).parse(await client.post(`v1/conversations/${conversation}/messages`, { json: { client_message_id: crypto.randomUUID(), content } }).json());
  const started = Date.now(), shellMarker = `LINUX_FILE_${crypto.randomUUID()}`, wakeMarker = `LINUX_WAKE_${crypto.randomUUID()}`;
  const computerMarker = `COMPUTER_LINUX_${crypto.randomUUID()}`;
  const initial = await post(computerProbe ? `Use only the computer tool for this harmless UI test. Capture a screenshot of the current desktop, focus the existing Chrome browser address bar with Ctrl+L, type exactly ${computerMarker}, then capture a second screenshot and report the marker you can actually see. Do not press Enter, do not navigate, and do not use shell or publish any files. Leave the marker visible for verification.` : `Perform this harmless runtime verification now. Using the shell tool, create a new proof.txt file inside OUTPUT_DIR containing exactly three lines: ${shellMarker}, the actual output of uname -s, and the actual output of uname -m. Read it back with shell, then publish it using publish_artifact as text/plain and report the observed platform. Do not modify other files or create schedules yet.`);
  console.log(JSON.stringify({ phase: computerProbe ? "computer_requested" : "shell_requested", conversation_id: conversation, task_id: initial.task.id, mode }));
  const awaitTask = async (id: string, limit: number) => {
    const until = Date.now() + limit;
    while (Date.now() < until) {
      const task = (await tasks()).find(t => t.id === id);
      if (task?.state === "succeeded") return;
      if (task && ["failed", "unknown", "cancelled"].includes(task.state)) throw new LinuxProbeError(`task_${task.state}`);
      await Bun.sleep(1500);
    }
    throw new LinuxProbeError("task_deadline");
  };
  try {
    await awaitTask(initial.task.id, 150000);
    if (computerProbe) {
      const reply = (await messages()).filter(m => m.role === "assistant").at(-1);
      if (!reply?.content.includes(computerMarker)) throw new LinuxProbeError("computer_observation_reply_missing");
      console.log(JSON.stringify({ verified_at:new Date().toISOString(),mode,phase:"computer_reply_completed",conversation_id:conversation,task_id:initial.task.id,marker:computerMarker,assistant_message_id:reply.id,elapsed_ms:Date.now()-started,requires_independent_screen_and_journal_check:true }));
      return;
    }
    const file = (await messages()).filter(m => m.role === "assistant").flatMap(m => m.attachments ?? []).find(a => a.state === "ready");
    if (!file) throw new LinuxProbeError("published_attachment_missing");
    const bytes = new Uint8Array(await client.get(`v1/artifacts/${file.id}/content`).arrayBuffer());
    const content = new TextDecoder().decode(bytes).trim().split(/\r?\n/);
    if (content[0] !== shellMarker || content[1] !== "Linux" || !content[2] || content.length !== 3 || bytes.byteLength !== file.bytes || new Bun.CryptoHasher("sha256").update(bytes).digest("hex") !== file.sha256) throw new LinuxProbeError("linux_artifact_mismatch");
    console.log(JSON.stringify({ phase: "linux_file_verified", artifact_id: file.id, os: content[1], architecture: content[2], bytes: file.bytes }));
    const reminderStarted = Date.now();
    const reminder = await post(`For one final behavior test, send me one unsolicited follow-up message about twenty seconds from now containing exactly the marker ${wakeMarker}. Only one follow-up, no recurring schedule. Persist the one-shot reminder now. Do not send the marker in your scheduling confirmation; send it only when the reminder actually wakes.`);
    await awaitTask(reminder.task.id, 150000);
    let enrolled = await schedules();
    const schedule = enrolled[0];
    if (enrolled.length !== 1 || !schedule || schedule.source_message_id !== reminder.message.id || Date.parse(schedule.due_at) < reminderStarted + 10000 || Date.parse(schedule.due_at) > Date.now() + 90000) throw new LinuxProbeError("one_shot_enrollment_mismatch");
    console.log(JSON.stringify({ phase: "reminder_enrolled", schedule_id: schedule.id, due_at: schedule.due_at, source_bound: true }));
    const until = Date.now() + 180000;
    let wake: Message | undefined, reply: Message | undefined, wakeTask: Task | undefined;
    while (Date.now() < until) {
      const timeline = await messages(), machineWakes = timeline.filter(m => m.role === "system" && m.sequence > reminder.message.sequence);
      if (machineWakes.length > 1) throw new LinuxProbeError("duplicate_wake");
      wake = machineWakes[0];
      if (wake) {
        const wakeSequence = wake.sequence;
        reply = timeline.find(m => m.role === "assistant" && m.sequence > wakeSequence && m.content.includes(wakeMarker));
        wakeTask = (await tasks()).find(t => t.conversation_id === conversation && t.id !== initial.task.id && t.id !== reminder.task.id);
        if (wakeTask && ["unknown", "failed", "cancelled"].includes(wakeTask.state)) throw new LinuxProbeError(`wake_${wakeTask.state}`);
        if (reply && wakeTask?.state === "succeeded") break;
      }
      await Bun.sleep(2000);
    }
    enrolled = await schedules();
    if (!wake || !reply || wakeTask?.state !== "succeeded" || enrolled.length !== 1 || enrolled[0]?.status !== "delivered") throw new LinuxProbeError("durable_followup_missing");
    console.log(JSON.stringify({ verified_at: new Date().toISOString(), mode, surface: "deployed Cloudflare API + installed Linux systemd daemon + actual provider + R2", conversation_id: conversation, shell_task_id: initial.task.id, shell_artifact_id: file.id, shell_os: content[1], shell_architecture: content[2], published_hash_verified: true, reminder_task_id: reminder.task.id, schedule_id: schedule.id, system_wake_id: wake.id, followup_task_id: wakeTask.id, assistant_followup_id: reply.id, one_schedule_one_wake: true, source_user_bound: true, elapsed_ms: Date.now() - started }));
  } finally {
    for (const schedule of await schedules()) if (schedule.status === "pending") await client.delete(`v1/schedules/${schedule.id}`);
  }
}
try { await probe(); }
catch (error) {
  console.error(JSON.stringify({ failed: true, type: error instanceof Error ? error.name : "unknown", code: error instanceof LinuxProbeError ? error.code : error instanceof HTTPError ? `http_${error.response.status}` : "probe_failed" }));
  process.exitCode = 1;
}
