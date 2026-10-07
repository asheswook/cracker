import OpenAI from "openai";
import { z } from "zod";
import { OpenAIProvider, type ResponseInputItem, type Tool } from "../packages/provider";

class ProbeError extends Error { constructor(readonly code: string) { super(code); this.name = "ProbeError"; } }
if (process.argv.includes("--help")) {
  console.log("PROVIDER_MODE=api|chatgpt OPENAI_MODEL=... OPENAI_API_KEY=... or CHATGPT_TOKEN_FILE=... bun scripts/probe-provider.ts\nOptional PROBE_IMAGE=path.png verifies image input with a real tool round-trip. Makes billable requests in API mode.");
  process.exit(0);
}
const config = z.object({ PROVIDER_MODE: z.enum(["api", "chatgpt"]), OPENAI_MODEL: z.string().min(1), OPENAI_API_KEY: z.string().optional(), CHATGPT_TOKEN_FILE: z.string().optional(), PROBE_IMAGE: z.string().optional() }).parse(process.env);
const provider = new OpenAIProvider({ mode: config.PROVIDER_MODE, model: config.OPENAI_MODEL, ...(config.OPENAI_API_KEY ? { apiKey: config.OPENAI_API_KEY } : {}), ...(config.CHATGPT_TOKEN_FILE ? { tokenFile: config.CHATGPT_TOKEN_FILE } : {}) });
const input: ResponseInputItem[] = [{ role: "user", content: "This is a connectivity test. Call add with a=19 and b=23, then return its result as digits only. Do not calculate without calling the tool." }];
if (config.PROBE_IMAGE) input.push({ role: "user", content: [{ type: "input_image", image_url: `data:image/png;base64,${Buffer.from(await Bun.file(config.PROBE_IMAGE).arrayBuffer()).toString("base64")}`, detail: "low" }] });
const tools: Tool[] = [{ type: "function", name: "add", description: "Add the two input integers.", strict: true, parameters: { type: "object", properties: { a: { type: "integer" }, b: { type: "integer" } }, required: ["a", "b"], additionalProperties: false } }];
try {
  const first = await provider.respond(input, tools, AbortSignal.timeout(120000));
  const call = first.output.find(item => item.type === "function_call" && item.name === "add");
  if (!call || call.type !== "function_call") throw new ProbeError("tool_not_called");
  const args = z.object({ a: z.literal(19), b: z.literal(23) }).parse(JSON.parse(call.arguments));
  for (const item of first.output) {
    if (item.type === "message" || item.type === "function_call" || item.type === "reasoning") input.push(item);
  }
  input.push({ type: "function_call_output", call_id: call.call_id, output: JSON.stringify({ result: args.a + args.b }) });
  const last = await provider.respond(input, tools, AbortSignal.timeout(120000));
  const answer = last.output.flatMap(item => item.type === "message" ? item.content.flatMap(part => part.type === "output_text" ? [part.text] : []) : []).join("").trim();
  if (answer !== "42") throw new ProbeError("tool_result_not_reflected");
  console.log(JSON.stringify({ verified_at: new Date().toISOString(), mode: config.PROVIDER_MODE, model: config.OPENAI_MODEL, image_input: Boolean(config.PROBE_IMAGE), function_call: true, tool_result_reflected: true, terminal_completed: true }));
} catch (error) {
  if (error instanceof OpenAI.APIError) console.error(JSON.stringify({ mode: config.PROVIDER_MODE, status: error.status, code: error.code, type: error.type }));
  else if (error instanceof Error) console.error(JSON.stringify({ mode: config.PROVIDER_MODE, error: error.name, code: error instanceof ProbeError ? error.code : "probe_failed" }));
  else throw error;
  process.exitCode = 1;
}
