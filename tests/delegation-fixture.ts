import type { Response, ResponseOutputItem } from "openai/resources/responses/responses";
import { z } from "zod";
export const response = (output: ResponseOutputItem[]): Response => ({
  id: crypto.randomUUID(),
  created_at: 0,
  output_text: "",
  error: null,
  incomplete_details: null,
  instructions: null,
  metadata: null,
  model: "fixture",
  object: "response",
  output,
  parallel_tool_calls: true,
  temperature: null,
  tool_choice: "auto",
  tools: [],
  top_p: null,
  status: "completed",
});
export const final = (text: string) =>
  response([
    {
      type: "message",
      id: crypto.randomUUID(),
      role: "assistant",
      status: "completed",
      content: [{ type: "output_text", text, annotations: [] }],
    },
  ]);
export const status = z.object({
  agent_id: z.string(),
  state: z.string(),
  result: z.string().nullable().optional(),
});
