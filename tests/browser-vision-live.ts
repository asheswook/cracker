import ky, { HTTPError } from "ky";
import { z } from "zod";
import { Message, Task } from "../packages/protocol";

class VisionProbeError extends Error {
  constructor(readonly code: string) {
    super(code);
    this.name = "VisionProbeError";
  }
}

async function probe(): Promise<void> {
  const config = z
    .object({ control_url: z.url(), client_token: z.string() })
    .parse(await Bun.file(".local/remote-connection.json").json());
  const http = ky.create({
    prefixUrl: config.control_url,
    headers: { Authorization: `Bearer ${config.client_token}` },
    retry: 0,
    timeout: 15000,
  });
  const tasks = async () =>
    z.object({ tasks: z.array(Task) }).parse(await http.get("v1/tasks").json()).tasks;
  if ((await tasks()).some((task) => !["succeeded", "failed", "cancelled"].includes(task.state)))
    throw new VisionProbeError("active_task");
  const vms = z
    .object({ vms: z.array(z.object({ control_state: z.string() })) })
    .parse(await http.get("v1/vms").json());
  if (vms.vms.some((vm) => vm.control_state !== "agent"))
    throw new VisionProbeError("user_control");
  const conversation = z
    .object({ conversation: z.object({ id: z.uuid() }) })
    .parse(
      await http.post("v1/conversations", { json: { title: "Browser visual acceptance" } }).json(),
    ).conversation.id;
  const marker = `VISION_${crypto.randomUUID().replaceAll("-", "")}`;
  const content = `Use only computer_exec and actual desktop screenshots for this browser acceptance test. Do not use shell, MCP, HTTP fetch, DOM inspection, Playwright, or browser developer tools. Start by observing the desktop. Activate Chrome using the dock, create ONE new tab without closing or changing existing tabs, and visit https://developers.cloudflare.com/workflows/. Use the visible page navigation to open its Limits page. Read the limits table from pixels: maximum steps per Workflow for Workers Free and Workers Paid (including the configurable paid maximum), and maximum event payload size. Take a screenshot showing the relevant table. Then use browser Back to return to the Workflows overview and observe that it returned. Leave that new tab open. Do not log in, submit forms, download files, or create schedules. Report only values actually observed and the marker ${marker}. If navigation or reading fails, report the failure honestly.`;
  const task = z
    .object({ task: Task })
    .parse(
      await http
        .post(`v1/conversations/${conversation}/messages`, {
          json: { client_message_id: crypto.randomUUID(), content },
        })
        .json(),
    ).task;
  console.log(
    JSON.stringify({ phase: "requested", task_id: task.id, conversation_id: conversation, marker }),
  );
  const deadline = Date.now() + 300000;
  while (Date.now() < deadline) {
    const current = (await tasks()).find((value) => value.id === task.id);
    if (current?.state === "succeeded") {
      const messages = z
        .object({ messages: z.array(Message) })
        .parse(await http.get(`v1/conversations/${conversation}/messages`).json()).messages;
      const reply =
        messages.filter((message) => message.role === "assistant").at(-1)?.content ?? "";
      const observedValues = [/1,?024/, /10,?000/, /25,?000/, /1\s?MiB/i].every((pattern) =>
        pattern.test(reply),
      );
      console.log(
        JSON.stringify({
          phase: "completed",
          task_id: task.id,
          duration_ms: Date.parse(current.updated_at) - Date.parse(current.created_at),
          marker_present: reply.includes(marker),
          expected_values_present: observedValues,
          reply,
          independent_screenshot_and_tool_journal_check_required: true,
        }),
      );
      if (!reply.includes(marker) || !observedValues)
        throw new VisionProbeError("visual_answer_mismatch");
      return;
    }
    if (current && ["unknown", "failed", "cancelled"].includes(current.state))
      throw new VisionProbeError(`task_${current.state}`);
    await Bun.sleep(2000);
  }
  throw new VisionProbeError("deadline_exceeded");
}

try {
  await probe();
} catch (error) {
  console.error(
    JSON.stringify({
      failed: true,
      code:
        error instanceof VisionProbeError
          ? error.code
          : error instanceof HTTPError
            ? `http_${error.response.status}`
            : "probe_failed",
    }),
  );
  process.exitCode = 1;
}
