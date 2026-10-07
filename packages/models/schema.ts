import { z } from "zod";

export const ModelProvider = z.enum(["chatgpt", "openai", "anthropic"]);
export const ModelSelection = z.object({
  provider: ModelProvider,
  model: z.string().trim().min(1).max(120).regex(/^[a-zA-Z0-9][a-zA-Z0-9._:-]*$/),
  reasoning_effort: z.enum(["low", "medium", "high", "xhigh", "max"]).nullable(),
}).strict().superRefine((value, ctx) => {
  if (value.provider === "anthropic" && (!value.model.startsWith("claude-") || value.reasoning_effort !== null))
    ctx.addIssue({ code: "custom", message: "Claude requires a Claude model and its native reasoning configuration" });
  if (value.provider !== "anthropic" && !value.model.startsWith("gpt-"))
    ctx.addIssue({ code: "custom", message: "OpenAI connections require a GPT model" });
});
export type ModelSelection = z.infer<typeof ModelSelection>;
export const ModelBinding = z.object({ revision_id: z.uuid().nullable(), selection: ModelSelection });
export type ModelBinding = z.infer<typeof ModelBinding>;
export const ModelDefaults = z.object({ selection: ModelSelection, available: z.array(ModelProvider).max(3) }).strict();
export const ModelSettings = z.object({
  vm_id: z.uuid(),
  binding: ModelBinding.nullable(),
  defaults: ModelDefaults.nullable(),
  saved_credentials: z.array(ModelProvider),
});
export const SaveModelSettings = z.object({
  vm_id: z.uuid(),
  expected_revision_id: z.uuid().nullable(),
  selection: ModelSelection,
  api_key: z.string().trim().min(1).max(4096).optional(),
}).strict();
export const ModelAccess = z.object({ binding: ModelBinding.nullable(), api_key: z.string().nullable() });
export type ModelAccess = z.infer<typeof ModelAccess>;
