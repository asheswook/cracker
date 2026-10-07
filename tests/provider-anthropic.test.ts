import { expect, test } from "bun:test";
import Anthropic from "@anthropic-ai/sdk";
import type { ContentBlock, Message, StopReason } from "@anthropic-ai/sdk/resources/messages";
import type { Response, ResponseInputItem, Tool } from "openai/resources/responses/responses";
import { AnthropicProvider } from "../packages/provider/anthropic.ts";
import {
  anthropicResponse,
  anthropicTools,
  anthropicTranscript,
} from "../packages/provider/anthropic-messages.ts";
import { planResponse } from "../packages/provider/response-plan.ts";
import type { ProviderResponseEvent } from "../packages/provider/index.ts";

const model = "claude-opus-5-5";
const shell = {
  type: "function",
  name: "shell",
  description: "Execute a shell command",
  strict: true,
  parameters: {
    type: "object" as const,
    properties: { command: { type: "string" } },
    required: ["command"],
    additionalProperties: false,
  },
} satisfies Tool;
const toolBlock: ContentBlock = {
  type: "tool_use",
  id: "toolu_fixture_1",
  name: "shell",
  input: { command: "pwd" },
  caller: { type: "direct" },
};
const thoughts: ContentBlock = {
  type: "thinking",
  thinking: "fixture internal content",
  signature: "signed-fixture-value",
};
const text = (value: string): ContentBlock => ({ type: "text", text: value, citations: null });
const message = (blocks: ContentBlock[], stop: StopReason = "end_turn"): Message => ({
  id: "msg_fixture",
  type: "message",
  role: "assistant",
  model,
  content: blocks,
  stop_reason: stop,
  stop_sequence: null,
  stop_details: null,
  container: null,
  diagnostics: null,
  usage: {
    input_tokens: 10,
    output_tokens: 20,
    cache_creation_input_tokens: 3,
    cache_read_input_tokens: 7,
    cache_creation: null,
    inference_geo: null,
    output_tokens_details: { thinking_tokens: 5 },
    server_tool_use: null,
    service_tier: "standard",
  },
});
const input: ResponseInputItem[] = [
  { role: "system", content: "fixture system" },
  { role: "user", content: "fixture request" },
];
const historyItems = (response: Response): ResponseInputItem[] =>
  response.output.filter(
    (item) => item.type === "message" || item.type === "function_call" || item.type === "reasoning",
  );
type WireEvent = { readonly type: string; readonly [key: string]: unknown };
const event = (value: WireEvent): string =>
  `event: ${value.type}\ndata: ${JSON.stringify(value)}\n\n`;

function wire(result: Message, complete = true): string {
  const events: WireEvent[] = [
    { type: "message_start", message: { ...result, content: [], stop_reason: null } },
  ];
  for (const [index, block] of result.content.entries()) {
    switch (block.type) {
      case "text":
        events.push({ type: "content_block_start", index, content_block: { ...block, text: "" } });
        events.push({
          type: "content_block_delta",
          index,
          delta: { type: "text_delta", text: block.text },
        });
        break;
      case "thinking":
        events.push({
          type: "content_block_start",
          index,
          content_block: { ...block, thinking: "", signature: "" },
        });
        events.push({
          type: "content_block_delta",
          index,
          delta: { type: "thinking_delta", thinking: block.thinking },
        });
        events.push({
          type: "content_block_delta",
          index,
          delta: { type: "signature_delta", signature: block.signature },
        });
        break;
      case "tool_use": {
        const args = JSON.stringify(block.input);
        events.push({ type: "content_block_start", index, content_block: { ...block, input: {} } });
        events.push({
          type: "content_block_delta",
          index,
          delta: { type: "input_json_delta", partial_json: args.slice(0, 7) },
        });
        events.push({
          type: "content_block_delta",
          index,
          delta: { type: "input_json_delta", partial_json: args.slice(7) },
        });
        break;
      }
      default:
        events.push({ type: "content_block_start", index, content_block: block });
    }
    events.push({ type: "content_block_stop", index });
  }
  events.push({
    type: "message_delta",
    delta: {
      stop_reason: result.stop_reason,
      stop_sequence: null,
      stop_details: result.stop_details,
    },
    usage: { output_tokens: result.usage.output_tokens },
  });
  if (complete) events.push({ type: "message_stop" });
  return events.map(event).join("");
}

test("Claude preserves system, structured tools, tool IDs, screenshots and signed thinking through a tool round trip", () => {
  // Given
  const result = anthropicResponse(
    message([thoughts, text("Working"), toolBlock], "tool_use"),
    [shell],
    model,
  );
  const history: ResponseInputItem[] = [
    ...input,
    ...historyItems(result),
    { type: "function_call_output", call_id: "toolu_fixture_1", output: "observed" },
    {
      role: "user",
      content: [
        { type: "input_image", image_url: "data:image/png;base64,aGVsbG8=", detail: "original" },
      ],
    },
    { role: "system", content: "current clock" },
  ];
  // When
  const request = anthropicTranscript(history, model);
  // Then
  expect(planResponse(result, [shell]).kind).toBe("calls");
  expect(request.system.map((part) => part.text)).toEqual(["fixture system", "current clock"]);
  expect(request.messages.map((turn) => turn.role)).toEqual(["user", "assistant", "user"]);
  expect(request.messages[1]?.content).toEqual([
    thoughts,
    { type: "text", text: "Working" },
    { type: "tool_use", id: "toolu_fixture_1", name: "shell", input: { command: "pwd" } },
  ]);
  expect(request.messages[2]?.content).toEqual([
    {
      type: "tool_result",
      tool_use_id: "toolu_fixture_1",
      content: [{ type: "text", text: "observed" }],
    },
    { type: "image", source: { type: "base64", media_type: "image/png", data: "aGVsbG8=" } },
  ]);
  expect(anthropicTools([shell])).toEqual([
    { name: "shell", description: shell.description, input_schema: shell.parameters, strict: true },
  ]);
  expect(result.usage?.input_tokens).toBe(20);
  expect(result.usage?.total_tokens).toBe(40);
});

test("Claude groups parallel tool results before user images without dropping history", () => {
  // Given
  const history: ResponseInputItem[] = [
    ...input,
    { type: "function_call", name: "shell", call_id: "a", arguments: "{}" },
    { type: "function_call", name: "shell", call_id: "b", arguments: "{}" },
    { type: "function_call_output", call_id: "a", output: "first" },
    {
      role: "user",
      content: [
        { type: "input_image", image_url: "https://example.com/screen.png", detail: "auto" },
      ],
    },
    { type: "function_call_output", call_id: "b", output: "second" },
  ];
  // When
  const request = anthropicTranscript(history, model);
  // Then
  expect(request.messages[2]?.content).toEqual([
    { type: "tool_result", tool_use_id: "a", content: [{ type: "text", text: "first" }] },
    { type: "tool_result", tool_use_id: "b", content: [{ type: "text", text: "second" }] },
    { type: "image", source: { type: "url", url: "https://example.com/screen.png" } },
  ]);
});

test("Claude thinking and redacted thinking stay opaque and restore losslessly", () => {
  // Given
  const result = anthropicResponse(
    message([thoughts, { type: "redacted_thinking", data: "opaque-redacted" }, text("Answer")]),
    [],
    model,
  );
  // When
  const request = anthropicTranscript(
    [...input, ...historyItems(result), { role: "user", content: "Continue" }],
    model,
  );
  // Then
  expect(request.messages[1]?.content).toEqual([
    thoughts,
    { type: "redacted_thinking", data: "opaque-redacted" },
    { type: "text", text: "Answer" },
  ]);
  expect(result.output_text).toBe("Answer");
  expect(() =>
    anthropicTranscript(
      [...input, ...historyItems(result), { role: "user", content: "Continue" }],
      "other-model",
    ),
  ).toThrow("another model");
});

test.each([
  { type: "reasoning", id: "foreign", summary: [], encrypted_content: "openai-opaque" },
  { type: "compaction", id: "foreign", encrypted_content: "openai-compaction" },
  { type: "item_reference", id: "reference" },
  { role: "user", content: [{ type: "input_file", file_id: "file-other-provider" }] },
  {
    role: "user",
    content: [{ type: "input_image", file_id: "file-other-provider", detail: "auto" }],
  },
] satisfies ResponseInputItem[])(
  "Claude rejects incompatible history instead of dropping it: %j",
  (item) => {
    // Given / When / Then
    expect(() => anthropicTranscript([...input, item], model)).toThrow();
  },
);

test.each(
  (
    [
      [{ type: "function_call_output", call_id: "orphan", output: "bad" }],
      [{ type: "function_call", call_id: "missing", name: "shell", arguments: "{}" }],
      [{ type: "function_call", call_id: "bad", name: "shell", arguments: "[]" }],
      [{ role: "assistant", content: "prefill" }],
    ] satisfies ResponseInputItem[][]
  ).map((extra) => ({ extra })),
)("Claude rejects invalid boundaries: %j", ({ extra }) => {
  // Given / When / Then
  expect(() => anthropicTranscript([...input, ...extra], model)).toThrow();
});

test.each([
  "max_tokens",
  "pause_turn",
  "stop_sequence",
  "model_context_window_exceeded",
] satisfies StopReason[])("Claude fails closed on %s", (stop) => {
  // Given / When / Then
  expect(() => anthropicResponse(message([text("partial")], stop), [], model)).toThrow(
    "did not complete",
  );
});

test("Claude distinguishes refusals, empty output, tool mismatch and model mismatch", () => {
  // Given
  const refusal = anthropicResponse(message([], "refusal"), [], model);
  // When / Then
  expect(planResponse(refusal, []).kind).toBe("refusal");
  expect(() => anthropicResponse(message([thoughts]), [], model)).toThrow("does not match");
  expect(() => anthropicResponse(message([toolBlock]), [shell], model)).toThrow("does not match");
  expect(() => anthropicResponse(message([text("done")], "tool_use"), [shell], model)).toThrow(
    "does not match",
  );
  expect(() => anthropicResponse(message([text("done")]), [], "other-model")).toThrow(
    "different model",
  );
});

test("official Claude SDK streams fragmented tool JSON over local HTTP with text-only observer events", async () => {
  // Given
  const bodies: unknown[] = [];
  const observed: ProviderResponseEvent[] = [];
  const server = Bun.serve({
    hostname: "127.0.0.1",
    port: 0,
    async fetch(request) {
      bodies.push(await request.json());
      return new Response(
        wire(message([thoughts, text(" "), text("Working"), toolBlock], "tool_use")),
        { headers: { "content-type": "text/event-stream" } },
      );
    },
  });
  const sdk = new Anthropic({
    apiKey: "fixture-key",
    baseURL: `http://127.0.0.1:${server.port}`,
    maxRetries: 0,
  });
  const provider = new AnthropicProvider({ model, apiKey: "fixture-key" }, sdk);
  try {
    // When
    const result = await provider.respond(input, [shell], new AbortController().signal, (event) =>
      observed.push(event),
    );
    // Then
    expect(planResponse(result, [shell]).kind).toBe("calls");
    expect(result.output.find((item) => item.type === "function_call")).toMatchObject({
      call_id: "toolu_fixture_1",
      arguments: '{"command":"pwd"}',
    });
    expect(bodies[0]).toMatchObject({
      model,
      stream: true,
      service_tier: "standard_only",
      tool_choice: { type: "auto", disable_parallel_tool_use: false },
    });
    expect(observed).toEqual([
      { type: "text_delta", response_id: "msg_fixture", item_id: "msg_fixture_2" },
      { type: "text_done", response_id: "msg_fixture", item_id: "msg_fixture_2" },
      { type: "response_done", response_id: "msg_fixture" },
    ]);
  } finally {
    provider.close();
    server.stop(true);
  }
});

test("official Claude SDK rejects a stream missing message_stop and clears its observer", async () => {
  // Given
  const observed: ProviderResponseEvent[] = [];
  const server = Bun.serve({
    hostname: "127.0.0.1",
    port: 0,
    fetch() {
      return new Response(wire(message([text("partial")]), false), {
        headers: { "content-type": "text/event-stream" },
      });
    },
  });
  const provider = new AnthropicProvider(
    { model, apiKey: "fixture-key" },
    new Anthropic({
      apiKey: "fixture-key",
      baseURL: `http://127.0.0.1:${server.port}`,
      maxRetries: 0,
    }),
  );
  try {
    // When / Then
    await expect(
      provider.respond(input, [], new AbortController().signal, (event) => observed.push(event)),
    ).rejects.toThrow();
    expect(observed.at(-1)).toEqual({ type: "response_done", response_id: "msg_fixture" });
  } finally {
    provider.close();
    server.stop(true);
  }
});

test("official Claude SDK sends its signed tool round trip and returns a final answer on the second HTTP request", async () => {
  // Given
  const bodies: unknown[] = [];
  const server = Bun.serve({
    hostname: "127.0.0.1",
    port: 0,
    async fetch(request) {
      bodies.push(await request.json());
      const response =
        bodies.length === 1
          ? message([thoughts, toolBlock], "tool_use")
          : { ...message([text("Tool result received")]), id: "msg_final" };
      return new Response(wire(response), { headers: { "content-type": "text/event-stream" } });
    },
  });
  const provider = new AnthropicProvider(
    { model, apiKey: "fixture-key" },
    new Anthropic({
      apiKey: "fixture-key",
      baseURL: `http://127.0.0.1:${server.port}`,
      maxRetries: 0,
    }),
  );
  try {
    // When
    const first = await provider.respond(input, [shell], new AbortController().signal);
    const second = await provider.respond(
      [
        ...input,
        ...historyItems(first),
        {
          type: "function_call_output",
          call_id: "toolu_fixture_1",
          output: [
            { type: "input_text", text: "observed" },
            {
              type: "input_image",
              image_url: "https://example.com/screen.png",
              detail: "original",
            },
          ],
        },
      ],
      [shell],
      new AbortController().signal,
    );
    // Then
    expect(planResponse(second, [shell]).kind).toBe("final");
    expect(second.output_text).toBe("Tool result received");
    expect(bodies[1]).toMatchObject({
      messages: [
        { role: "user", content: [{ type: "text", text: "fixture request" }] },
        {
          role: "assistant",
          content: [
            thoughts,
            { type: "tool_use", id: "toolu_fixture_1", name: "shell", input: { command: "pwd" } },
          ],
        },
        {
          role: "user",
          content: [
            {
              type: "tool_result",
              tool_use_id: "toolu_fixture_1",
              content: [
                { type: "text", text: "observed" },
                { type: "image", source: { type: "url", url: "https://example.com/screen.png" } },
              ],
            },
          ],
        },
      ],
    });
  } finally {
    provider.close();
    server.stop(true);
  }
});

test("Claude streaming API errors clear response activity and do not produce a successful result", async () => {
  // Given
  const observed: ProviderResponseEvent[] = [];
  const server = Bun.serve({
    hostname: "127.0.0.1",
    port: 0,
    fetch() {
      return new Response(
        event({ type: "message_start", message: { ...message([]), stop_reason: null } }) +
          event({
            type: "error",
            error: { type: "overloaded_error", message: "fixture overload" },
          }),
        { headers: { "content-type": "text/event-stream" } },
      );
    },
  });
  const provider = new AnthropicProvider(
    { model, apiKey: "fixture-key" },
    new Anthropic({
      apiKey: "fixture-key",
      baseURL: `http://127.0.0.1:${server.port}`,
      maxRetries: 0,
    }),
  );
  try {
    // When / Then
    await expect(
      provider.respond(input, [], new AbortController().signal, (value) => observed.push(value)),
    ).rejects.toThrow();
    expect(observed).toEqual([{ type: "response_done", response_id: "msg_fixture" }]);
  } finally {
    provider.close();
    server.stop(true);
  }
});

test("Claude cancellation aborts the active HTTP stream and clears observed response activity", async () => {
  // Given
  const started = Promise.withResolvers<void>();
  const observed: ProviderResponseEvent[] = [];
  const server = Bun.serve({
    hostname: "127.0.0.1",
    port: 0,
    fetch() {
      return new Response(
        new ReadableStream({
          start(controller) {
            controller.enqueue(
              new TextEncoder().encode(
                event({ type: "message_start", message: { ...message([]), stop_reason: null } }) +
                  event({ type: "content_block_start", index: 0, content_block: text("") }) +
                  event({
                    type: "content_block_delta",
                    index: 0,
                    delta: { type: "text_delta", text: "Working" },
                  }),
              ),
            );
          },
        }),
        { headers: { "content-type": "text/event-stream" } },
      );
    },
  });
  const provider = new AnthropicProvider(
    { model, apiKey: "fixture-key" },
    new Anthropic({
      apiKey: "fixture-key",
      baseURL: `http://127.0.0.1:${server.port}`,
      maxRetries: 0,
    }),
  );
  const controller = new AbortController();
  try {
    // When
    const request = provider.respond(input, [], controller.signal, (value) => {
      observed.push(value);
      if (value.type === "text_delta") started.resolve();
    });
    const settled = request.catch((error) => error);
    await started.promise;
    controller.abort();
    // Then
    expect(await settled).toBeInstanceOf(Error);
    expect(observed.at(-1)).toEqual({ type: "response_done", response_id: "msg_fixture" });
  } finally {
    provider.close();
    server.stop(true);
  }
});

test("Claude credentials are required and a closed provider cannot reopen", async () => {
  // Given / When / Then
  expect(() => new AnthropicProvider({ model, apiKey: "" })).toThrow("ANTHROPIC_API_KEY");
  const provider = new AnthropicProvider({ model, apiKey: "fixture-key" });
  provider.close();
  await expect(provider.respond(input, [], new AbortController().signal)).rejects.toThrow("closed");
});
