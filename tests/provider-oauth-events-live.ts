import OpenAI from "openai";
import { ResponsesWS } from "openai/resources/responses/ws";
import type { ResponseStreamEvent } from "openai/resources/responses/responses";
import { z } from "zod";
import { readCredential } from "../packages/provider/credentials";
import { consumeResponse, type Tool } from "../packages/provider";
import { planResponse } from "../packages/provider/response-plan";

async function observe() {
  if (process.platform !== "linux") throw new Error("vm_only");
  const credential = await readCredential(z.string().min(1).parse(process.env["CHATGPT_TOKEN_FILE"]));
  const ws = new ResponsesWS(new OpenAI({ apiKey: credential.access_token, maxRetries: 0 }), { reconnect: null });
  const events = ws.stream();
  const types = new Set<string>();
  const timeout = setTimeout(() => { ws.close(); ws.socket.platformSocket.terminate(); }, 30000);
  const tool: Tool = { type: "function", name: "report_view", description: "Name the foreground application.", strict: true, parameters: { type: "object", properties: { application: { type: "string" } }, required: ["application"], additionalProperties: false } };
  async function* messages(): AsyncGenerator<ResponseStreamEvent> {
    for await (const event of events) {
      if (event.type === "error" || event.type === "close" || event.type === "raw") throw new Error("transport_failed");
      if (event.type !== "message") continue;
      const name = z.string().regex(/^[a-z][a-z0-9_.]{0,100}$/).parse(event.message.type);
      types.add(name);
      yield event.message;
    }
  }
  try {
    const image = await Bun.file(".omo/evidence/desktop/batch-astra.png").arrayBuffer();
    ws.send({ type: "response.create", model: "gpt-6-astra", reasoning: { effort: "low" }, service_tier: "default", store: false, parallel_tool_calls: false, include: ["reasoning.encrypted_content"], tools: [tool], input: [{ role: "user", content: [{ type: "input_text", text: "Name the foreground application using report_view exactly once." }, { type: "input_image", image_url: `data:image/png;base64,${Buffer.from(image).toString("base64")}`, detail: "original" }] }] });
    const response = await consumeResponse(messages());
    const plan = planResponse(response, [tool], new Set());
    console.log(JSON.stringify({ status: response.status, plan: plan.kind, requested_tier: "default", returned_tier: response.service_tier, usage: response.usage ? {input_tokens:response.usage.input_tokens,output_tokens:response.usage.output_tokens,total_tokens:response.usage.total_tokens} : null, event_types: [...types] }));
  } finally {
    clearTimeout(timeout);
    ws.close(); ws.socket.platformSocket.terminate();
    await events.return?.();
  }
}
try { await observe(); } catch { console.error(JSON.stringify({ failed: true, code: "event_probe_failed" })); process.exitCode = 1; }
