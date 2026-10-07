import ky, { HTTPError } from "ky";
import { z } from "zod";
import { Message, Task } from "../packages/protocol/index.ts";

class DesktopProbeError extends Error {
  constructor(readonly code: string) {
    super(code);
    this.name = "DesktopProbeError";
  }
}

async function probe() {
  const tool = process.env["PROBE_DESKTOP_MODE"] === "batch" ? "computer_exec" : "computer";
  const connection = z
    .object({ control_url: z.url(), client_token: z.string().min(1) })
    .parse(await Bun.file(".local/remote-connection.json").json());
  const http = ky.create({
    prefixUrl: connection.control_url,
    headers: { Authorization: `Bearer ${connection.client_token}` },
    retry: 0,
    timeout: 15000,
  });
  const tasks = async () =>
    z.object({ tasks: z.array(Task) }).parse(await http.get("v1/tasks").json()).tasks;
  if ((await tasks()).some((task) => !["succeeded", "failed", "cancelled"].includes(task.state)))
    throw new DesktopProbeError("unrelated_active_task");
  const vm = z
    .object({ vms: z.array(z.object({ control_state: z.string() })) })
    .parse(await http.get("v1/vms").json());
  if (vm.vms.some((value) => value.control_state !== "agent"))
    throw new DesktopProbeError("user_control_active");
  const conversation = z
    .object({ conversation: z.object({ id: z.uuid() }) })
    .parse(
      await http
        .post("v1/conversations", { json: { title: "Desktop cross-application acceptance" } })
        .json(),
    ).conversation.id;
  const marker = `DESKTOP_${crypto.randomUUID().replaceAll("-", "")}`;
  const filename = `${marker}.txt`;
  const content = `검증 ${marker}`;
  const prompt = `Perform this harmless Linux desktop acceptance test using only the ${tool} tool; do not use shell, MCP, or any other tool. Start with a screenshot. Open the terminal using the desktop dock or keyboard shortcut. Using terminal keyboard input, create the directory "$HOME/Documents/Assistant-QA" if necessary and create a NEW file "$HOME/Documents/Assistant-QA/${filename}" containing exactly the single UTF-8 line '${content}' with a trailing newline. Read that file back in the terminal and screenshot the result. Then open the file manager using the desktop dock, navigate to /home/ubuntu/Documents/Assistant-QA, and take a screenshot showing the new filename. Leave the file manager visible. Do not modify other files, close existing browser windows, visit websites, or create schedules. Report the exact marker and only outcomes you observed. You may use desktop key/type to enter the harmless terminal commands; direct shell tool execution is excluded so the desktop input path is exercised.`;
  const initial = z.object({ task: Task }).parse(
    await http
      .post(`v1/conversations/${conversation}/messages`, {
        json: { client_message_id: crypto.randomUUID(), content: prompt },
      })
      .json(),
  );
  console.log(
    JSON.stringify({
      phase: "requested",
      tool,
      task_id: initial.task.id,
      conversation_id: conversation,
      filename,
      expected_content: content,
    }),
  );
  const deadline = Date.now() + 240000;
  while (Date.now() < deadline) {
    const task = (await tasks()).find((value) => value.id === initial.task.id);
    if (task?.state === "succeeded") {
      const messages = z
        .object({ messages: z.array(Message) })
        .parse(await http.get(`v1/conversations/${conversation}/messages`).json()).messages;
      const reply = messages.filter((message) => message.role === "assistant").at(-1);
      if (!reply?.content.includes(marker))
        throw new DesktopProbeError("observation_marker_missing");
      console.log(
        JSON.stringify({
          phase: "model_completed",
          task_id: task.id,
          filename,
          expected_content: content,
          independent_file_and_journal_check_required: true,
          created_at: task.created_at,
          completed_at: task.updated_at,
          duration_ms: Date.parse(task.updated_at) - Date.parse(task.created_at),
        }),
      );
      return;
    }
    if (task && ["unknown", "failed", "cancelled"].includes(task.state))
      throw new DesktopProbeError(`task_${task.state}`);
    await Bun.sleep(2000);
  }
  throw new DesktopProbeError("deadline_exceeded");
}

try {
  await probe();
} catch (error) {
  console.error(
    JSON.stringify({
      failed: true,
      code:
        error instanceof DesktopProbeError
          ? error.code
          : error instanceof HTTPError
            ? `http_${error.response.status}`
            : "probe_failed",
    }),
  );
  process.exitCode = 1;
}
