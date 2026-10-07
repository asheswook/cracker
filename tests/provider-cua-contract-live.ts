import { z } from "zod";
import { OpenAIProvider, type ResponseInputItem, type Tool } from "../packages/provider";
import { planResponse } from "../packages/provider/response-plan";
import { providerFailure } from "../packages/provider/diagnostic";

const tool: Tool = {
  type: "function",
  name: "report_view",
  strict: true,
  description:
    "Report the application visible in the foreground of the supplied desktop screenshot.",
  parameters: {
    type: "object",
    properties: { application: { type: "string" } },
    required: ["application"],
    additionalProperties: false,
  },
};
let provider:OpenAIProvider|undefined;
try {
  const transport=z.enum(["http","websocket"]).default("http").parse(process.env["PROBE_TRANSPORT"]);
  const mode=z.enum(["api","chatgpt"]).default("api").parse(process.env["PROBE_MODE"]);
  if(mode==="chatgpt" && process.platform!=="linux") throw new Error("oauth_probe_requires_vm");
  provider = new OpenAIProvider({
    mode,
    transport,
    serviceTier:"default",
    model: "gpt-6-astra",
    reasoningEffort: "low",
    ...(mode === "api"
      ? {apiKey:z.string().min(1).parse(process.env["OPENAI_API_KEY"])}
      : {tokenFile:z.string().min(1).parse(process.env["CHATGPT_TOKEN_FILE"])}),
  });
  const image = Buffer.from(await Bun.file(".omo/evidence/desktop/batch-astra.png").arrayBuffer());
  const input: ResponseInputItem[] = [
    {
      role: "user",
      content: [
        {
          type: "input_text",
          text: "Inspect this actual desktop screenshot. Call report_view once with the foreground application's name. After receiving the tool result, answer CUA_CONTRACT_OK and the application name. Do not call any other tool.",
        },
        {
          type: "input_image",
          image_url: `data:image/png;base64,${image.toString("base64")}`,
          detail: "original",
        },
      ],
    },
  ];
  const seen = new Set<string>();
  let calls = 0;
  let application = "";
  let completed = false;
  for (let turn = 0; turn < 5; turn++) {
    const started=performance.now();
    const response = await provider.respond(input, [tool], AbortSignal.timeout(120000));
    console.log(JSON.stringify({event:"cua_contract_response",transport,mode,turn:turn+1,requested_model:"gpt-6-astra",returned_model:response.model,requested_tier:"default",returned_tier:response.service_tier??null,response_ms:Math.round(performance.now()-started),usage:response.usage?{input_tokens:response.usage.input_tokens,output_tokens:response.usage.output_tokens,total_tokens:response.usage.total_tokens}:null}));
    const plan = planResponse(response, [tool], seen);
    for (const item of response.output) {
      if (item.type === "message" || item.type === "reasoning" || item.type === "function_call")
        input.push(item);
      if (item.type !== "function_call") continue;
      application = z
        .object({ application: z.string() })
        .parse(JSON.parse(item.arguments)).application;
      seen.add(item.call_id);
      calls++;
      input.push({
        type: "function_call_output",
        call_id: item.call_id,
        output: JSON.stringify({ observed: application }),
      });
    }
    if (plan.kind === "final") {
      completed = response.output_text.includes("CUA_CONTRACT_OK");
      break;
    }
  }
  if (!completed || calls !== 1 || !/thunar|file manager|파일/i.test(application))
    throw new Error("visual_contract_mismatch");
  console.log(
    JSON.stringify({
      result: "pass",
      transport,
      requested_tier:"default",
      mode,
      model: "gpt-6-astra",
      reasoning_effort: "low",
      original_image: true,
      full_response_validation: true,
      tool_calls: calls,
      observed_application: application,
    }),
  );
} catch (error) {
  console.error(
    JSON.stringify({ result: "failed", type: error instanceof Error ? error.name : "unknown", ...providerFailure(error) }),
  );
  process.exitCode = 1;
}finally{provider?.close();}
