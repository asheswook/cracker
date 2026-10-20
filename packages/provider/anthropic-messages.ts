import type {
  ContentBlockParam,
  ImageBlockParam,
  DocumentBlockParam,
  Message,
  MessageParam,
  TextBlockParam,
  Tool as AnthropicTool,
} from "@anthropic-ai/sdk/resources/messages";
import type { Response, ResponseInputItem, Tool } from "openai/resources/responses/responses";
import { z } from "zod";
import { ProviderError } from "./errors.ts";
import { anthropicDocument } from "./anthropic-files.ts";
import type { BetaMessage } from "@anthropic-ai/sdk/resources/beta/messages/messages";

const carrierPrefix = "anthropic:v1:";
const thinkingBlock = z.discriminatedUnion("type", [
  z
    .object({ type: z.literal("thinking"), thinking: z.string(), signature: z.string().min(1) })
    .catchall(z.unknown()),
  z.object({ type: z.literal("redacted_thinking"), data: z.string().min(1) }).catchall(z.unknown()),
]);
const carrier = z.object({ model: z.string(), block: thinkingBlock }).strict();
const jsonObject = z.record(z.string(), z.unknown());
const inputSchema = z.object({ type: z.literal("object") }).catchall(z.unknown());
const contentPart = z.discriminatedUnion("type", [
  z.object({ type: z.literal("input_text"), text: z.string() }),
  z.object({
    type: z.literal("output_text"),
    text: z.string(),
    annotations: z.array(z.unknown()).optional(),
  }),
  z.object({ type: z.literal("refusal"), refusal: z.string() }),
  z.object({
    type: z.literal("input_file"),
    filename: z.string().optional(),
    file_data: z.string().optional(),
    file_id: z.string().optional(),
    file_url: z.string().optional(),
  }),
  z.object({
    type: z.literal("input_image"),
    image_url: z.string().nullish(),
    file_id: z.string().nullish(),
  }),
]);

function invalid(message: string): never {
  throw new ProviderError("configuration", message);
}
function parseObject(value: string): Record<string, unknown> {
  try {
    return jsonObject.parse(JSON.parse(value));
  } catch (error) {
    if (error instanceof Error) return invalid("Claude tool arguments must be a JSON object");
    throw error;
  }
}
function image(url: string): ImageBlockParam {
  const encoded = /^data:(image\/(?:png|jpeg|gif|webp));base64,([A-Za-z0-9+/]+={0,2})$/.exec(url);
  if (encoded) {
    const mediaType = z
      .enum(["image/png", "image/jpeg", "image/gif", "image/webp"])
      .parse(encoded[1]);
    const data = encoded[2];
    if (!data || data.length % 4 !== 0) return invalid("Claude image base64 is invalid");
    return { type: "image", source: { type: "base64", media_type: mediaType, data } };
  }
  if (!URL.canParse(url) || !["https:", "http:"].includes(new URL(url).protocol))
    return invalid("Claude requires an HTTP image URL or supported base64 image");
  return { type: "image", source: { type: "url", url } };
}
function content(
  value: string | readonly unknown[],
): (TextBlockParam | ImageBlockParam | DocumentBlockParam)[] {
  if (typeof value === "string") return value ? [{ type: "text", text: value }] : [];
  return value.map((raw) => {
    const parsed = contentPart.safeParse(raw);
    if (!parsed.success) return invalid("Unsupported Claude message content");
    const part = parsed.data;
    switch (part.type) {
      case "input_text":
        return { type: "text", text: part.text };
      case "output_text":
        if (part.annotations?.length)
          return invalid("Claude cannot replay foreign text annotations");
        return { type: "text", text: part.text };
      case "refusal":
        return { type: "text", text: part.refusal };
      case "input_image":
        if (part.file_id || !part.image_url)
          return invalid("Claude cannot use OpenAI image file IDs");
        return image(part.image_url);
      case "input_file":
        return anthropicDocument(part);
    }
  });
}

export function anthropicTranscript(
  input: readonly ResponseInputItem[],
  model: string,
): { system: TextBlockParam[]; messages: MessageParam[] } {
  const system: TextBlockParam[] = [];
  const turns: { role: "user" | "assistant"; content: ContentBlockParam[] }[] = [];
  const pending = new Set<string>();
  const seen = new Set<string>();
  const append = (role: "user" | "assistant", blocks: ContentBlockParam[]) => {
    const last = turns.at(-1);
    if (last?.role === role) last.content.push(...blocks);
    else turns.push({ role, content: blocks });
  };
  for (const item of input) {
    switch (item.type) {
      case undefined:
      case "message": {
        if (!("content" in item) || !("role" in item))
          return invalid("Claude cannot replay response item references");
        const blocks = content(item.content);
        switch (item.role) {
          case "system":
          case "developer":
            for (const block of blocks) {
              if (block.type !== "text") return invalid("Claude system instructions must be text");
              system.push(block);
            }
            break;
          case "assistant":
            if (pending.size && turns.at(-1)?.role !== "assistant")
              return invalid("Claude tool results are missing before the next assistant turn");
            append("assistant", blocks);
            break;
          case "user":
            append("user", blocks);
            break;
        }
        break;
      }
      case "function_call":
        if (!item.call_id || seen.has(item.call_id))
          return invalid("Claude tool call IDs must be unique");
        if (pending.size && turns.at(-1)?.role !== "assistant")
          return invalid("Claude tool results are incomplete");
        seen.add(item.call_id);
        pending.add(item.call_id);
        append("assistant", [
          {
            type: "tool_use",
            id: item.call_id,
            name: item.name,
            input: parseObject(item.arguments),
          },
        ]);
        break;
      case "function_call_output":
        if (!pending.delete(item.call_id))
          return invalid("Claude tool result has no matching call");
        append("user", [
          { type: "tool_result", tool_use_id: item.call_id, content: content(item.output) },
        ]);
        break;
      case "reasoning": {
        if (!item.encrypted_content?.startsWith(carrierPrefix))
          return invalid("Claude cannot replay foreign reasoning");
        let parsed: z.infer<typeof carrier>;
        try {
          parsed = carrier.parse(JSON.parse(item.encrypted_content.slice(carrierPrefix.length)));
        } catch (error) {
          if (error instanceof Error) return invalid("Invalid Claude reasoning carrier");
          throw error;
        }
        if (parsed.model !== model) return invalid("Claude reasoning belongs to another model");
        if (pending.size && turns.at(-1)?.role !== "assistant")
          return invalid("Claude tool results are missing before thinking");
        append("assistant", [parsed.block]);
        break;
      }
      default:
        return invalid(`Unsupported Claude history item: ${item.type}`);
    }
  }
  if (pending.size) return invalid("Claude tool results are missing");
  if (!turns.length || turns.at(-1)?.role !== "user")
    return invalid("Claude input must end with a user turn");
  for (const turn of turns) {
    if (!turn.content.length) return invalid("Claude message content cannot be empty");
    if (turn.role === "user") {
      // Runtime appends screenshot messages between results; Claude requires results first.
      turn.content = [
        ...turn.content.filter((block) => block.type === "tool_result"),
        ...turn.content.filter((block) => block.type !== "tool_result"),
      ];
    }
  }
  return { system, messages: turns };
}

export function anthropicTools(tools: readonly Tool[]): AnthropicTool[] {
  return tools.map((tool) => {
    if (tool.type !== "function") return invalid(`Unsupported Claude tool type: ${tool.type}`);
    const schema = inputSchema.safeParse(tool.parameters);
    if (!schema.success) return invalid("Claude tools require an object JSON Schema");
    return {
      name: tool.name,
      input_schema: schema.data,
      ...(tool.description ? { description: tool.description } : {}),
      ...(tool.strict === null ? {} : { strict: tool.strict }),
    };
  });
}

export function anthropicOutput(message:{readonly id:string;readonly content:readonly (Message["content"][number]|BetaMessage["content"][number])[]},model:string,phase:"commentary"|"final_answer",refusal=false):Response["output"] {
  const output: Response["output"] = [];
  let visible = false;
  for (const [index, block] of message.content.entries()) {
    const id = `${message.id}_${index}`;
    switch (block.type) {
      case "thinking":
      case "redacted_thinking":
        if (!thinkingBlock.safeParse(block).success)
          throw new ProviderError(
            "incomplete",
            "Claude reasoning is missing its continuation signature",
          );
        output.push({
          type: "reasoning",
          id: `anthropic_${id}`,
          summary: [],
          encrypted_content: carrierPrefix + JSON.stringify({ model, block }),
        });
        break;
      case "text":
        if (block.citations?.length)
          throw new ProviderError("incomplete", "Unsupported Claude citations");
        if (block.text.trim()) visible = true;
        output.push({
          type: "message",
          id,
          role: "assistant",
          status: "completed",
          phase,
          content: refusal
            ? [{ type: "refusal", refusal: block.text }]
            : [{ type: "output_text", text: block.text, annotations: [] }],
        });
        break;
      case "tool_use":
        if (refusal || (block.caller && block.caller.type !== "direct") || block.toolset_name)
          throw new ProviderError("incomplete", "Unsupported Claude tool caller");
        if (!jsonObject.safeParse(block.input).success || !block.id.trim())
          throw new ProviderError("incomplete", "Invalid Claude tool input");
        output.push({
          type: "function_call",
          id,
          call_id: block.id,
          name: block.name,
          arguments: JSON.stringify(block.input),
          status: "completed",
        });
        break;
      default:
        throw new ProviderError("incomplete", `Unsupported Claude output block: ${block.type}`);
    }
  }
  if (refusal && !visible)
    output.push({
      type: "message",
      id: `${message.id}_refusal`,
      role: "assistant",
      status: "completed",
      content: [{ type: "refusal", refusal: "Claude declined this request." }],
    });
  return output;
}

export function anthropicResponse(message: Message | BetaMessage, tools: Tool[], model: string): Response {
  if (message.model !== model)
    throw new ProviderError("incomplete", "Claude returned a different model");
  const refusal = message.stop_reason === "refusal" || message.stop_details?.type === "refusal";
  if (!refusal && message.stop_reason !== "end_turn" && message.stop_reason !== "tool_use")
    throw new ProviderError("incomplete", `Claude did not complete: ${message.stop_reason}`);
  const output=anthropicOutput(message,model,message.stop_reason === "tool_use" ? "commentary" : "final_answer",refusal);
  const calls=output.filter(item=>item.type === "function_call").length;
  const visible=output.some(item=>item.type === "message"&&item.content.some(part=>part.type === "output_text"&&part.text.trim()||part.type === "refusal"&&part.refusal.trim()));
  if (
    !refusal &&
    ((message.stop_reason === "tool_use" && !calls) ||
      (message.stop_reason === "end_turn" && (calls > 0 || !visible)))
  )
    throw new ProviderError("incomplete", "Claude stop reason does not match its output");
  const cached = message.usage.cache_read_input_tokens ?? 0;
  const inputTokens =
    message.usage.input_tokens + cached + (message.usage.cache_creation_input_tokens ?? 0);
  return {
    id: message.id,
    object: "response",
    created_at: Math.floor(Date.now() / 1000),
    status: "completed",
    model: message.model,
    output,
    output_text: output
      .flatMap((item) =>
        item.type === "message"
          ? item.content.flatMap((part) => (part.type === "output_text" ? [part.text] : []))
          : [],
      )
      .join(""),
    error: null,
    incomplete_details: null,
    instructions: null,
    metadata: null,
    parallel_tool_calls: false,
    temperature: null,
    tool_choice: "auto",
    tools,
    top_p: null,
    usage: {
      input_tokens: inputTokens,
      output_tokens: message.usage.output_tokens,
      total_tokens: inputTokens + message.usage.output_tokens,
      input_tokens_details: {
        cached_tokens: cached,
        cache_write_tokens: message.usage.cache_creation_input_tokens ?? 0,
      },
      output_tokens_details: {
        reasoning_tokens: message.usage.output_tokens_details?.thinking_tokens ?? 0,
      },
    },
  };
}
