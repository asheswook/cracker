import { expect, test } from "bun:test";
import Anthropic from "@anthropic-ai/sdk";
import { AnthropicProvider } from "../packages/provider/anthropic.ts";
import {
  fixture,
  fixtureTool,
  model,
  message,
  wire,
  summaryBlock,
  addReply,
} from "./anthropic-context-fixture.ts";
import { NativeContextError, NativeContextState } from "../packages/provider/native-context.ts";
import type { ResponseInputItem } from "../packages/provider/index.ts";

const signal = () => new AbortController().signal;
const initial = (): ResponseInputItem[] => [
  { role: "system", content: "fixture policy" },
  { role: "user", content: "fixture original request" },
];

test("native token measurement excludes retired ledger media without committing a frame", async () => {
  const f = fixture({ count: () => 1234 });
  const oldData = Buffer.from("old").toString("base64"),
    newData = Buffer.from("new").toString("base64");
  const input: ResponseInputItem[] = [
    ...initial(),
    {
      role: "user",
      content: [
        { type: "input_image", image_url: `data:image/png;base64,${oldData}`, detail: "original" },
      ],
    },
  ];
  try {
    const first = await f.provider.nativeContext.respond({
      runId: "run",
      input,
      tools: [],
      signal: signal(),
      clock: "clock",
    });
    addReply(input, first.response.output);
    input.push({
      role: "user",
      content: [
        { type: "input_image", image_url: `data:image/png;base64,${newData}`, detail: "original" },
      ],
    });
    const state = await f.provider.nativeContext.compact({
      runId: "run",
      input,
      tools: [],
      state: first.state,
      signal: signal(),
    });
    if (!state) throw new TypeError("missing summary");
    const before = structuredClone(state);
    expect(
      await f.provider.nativeContext.measure({
        runId: "run",
        input,
        tools: [],
        state,
        signal: signal(),
        clock: "next",
      }),
    ).toBe(1234);
    expect(state).toEqual(before);
    expect(JSON.stringify(f.counts[0]?.messages)).not.toContain(oldData);
    expect(JSON.stringify(f.counts[0]?.messages)).toContain(newData);
    expect(f.requests).toHaveLength(2);
  } finally {
    await f.close();
  }
});

test("native preflight rejects unsupported remote media instead of pretending it was counted", async () => {
  const f = fixture();
  try {
    await expect(
      f.provider.nativeContext.measure({
        runId: "run",
        input: [
          {
            role: "user",
            content: [
              {
                type: "input_image",
                image_url: "https://example.com/image.png",
                detail: "original",
              },
            ],
          },
        ],
        tools: [],
        signal: signal(),
        clock: "clock",
      }),
    ).rejects.toThrow("uncountable_media");
    expect(f.counts).toHaveLength(0);
    expect(f.requests).toHaveLength(0);
  } finally {
    await f.close();
  }
});

for (const supported of [true, false, null, "summarize_false"] as const)
  test(`native capability reads API support ${supported} and beta/auth transport`, async () => {
    const f = fixture({
      capabilities: () =>
        Response.json({
          id: model,
          max_input_tokens: 200000,
          max_tokens: 32000,
          capabilities:
            supported === null
              ? null
              : {
                  compaction: {
                    supported: supported !== false,
                    summarize: { supported: supported === true },
                  },
                },
        }),
    });
    try {
      const result = await f.provider.nativeContext.capability(signal());
      expect(result.kind).toBe(supported === true ? "supported" : "unsupported");
      expect(f.headers).toEqual([
        { path: `/v1/models/${model}`, beta: "compact-2026-09-04", authPresent: true },
      ]);
      expect(await f.provider.nativeContext.capability(signal())).toEqual(result);
      expect(f.lookups()).toBe(1);
      expect(f.requests).toHaveLength(0);
    } finally {
      await f.close();
    }
  });

for (const selectedModel of ["claude-sonnet-5", "claude-future-9", "claude-opus-5-5-alias"])
  test(`unverified inline model ${selectedModel} stays on legacy transport`, async () => {
    const f = fixture({
      selectedModel,
      respond: () =>
        new Response(
          wire(message([{ type: "text", text: "done" }], "end_turn", "legacy", selectedModel)),
          { headers: { "content-type": "text/event-stream" } },
        ),
    });
    try {
      expect(await f.provider.nativeContext.capability(signal())).toEqual({
        kind: "unsupported",
        reason: "inline_system_unverified",
      });
      expect(f.lookups()).toBe(0);
      await f.provider.respond(initial(), [], signal());
      expect(f.requests[0]?.messages.map((turn) => turn.role)).toEqual(["user"]);
      expect(f.headers[0]?.beta).toBeNull();
    } finally {
      await f.close();
    }
  });

test("capability lookup failure is not cached and identity mismatch does not resolve aliases implicitly", async () => {
  let attempts = 0;
  const f = fixture({
    capabilities: () =>
      ++attempts === 1
        ? Response.json({ error: { type: "api_error", message: "fixture" } }, { status: 500 })
        : Response.json({
            id: "different-model",
            max_input_tokens: 200000,
            max_tokens: 32000,
            capabilities: { compaction: { supported: true, summarize: { supported: true } } },
          }),
  });
  try {
    expect(await f.provider.nativeContext.capability(signal())).toEqual({
      kind: "unsupported",
      reason: "capability_unavailable",
    });
    expect(await f.provider.nativeContext.capability(signal())).toEqual({
      kind: "unsupported",
      reason: "model_identity_mismatch",
    });
    expect(f.lookups()).toBe(2);
  } finally {
    await f.close();
  }
});

test("signed prefix compaction round-trips full native turns, unknown fields, images and repeated summaries across provider restart", async () => {
  let replies = 0,
    summaries = 0;
  const thought = {
    type: "thinking",
    thinking: "fixture",
    signature: "thinking-signature",
    future: { opaque: true },
  };
  const nativeReplies: unknown[][] = [];
  const f = fixture({
    respond: (body) => {
      if (body.compaction)
        return new Response(
          wire(message([{ ...summaryBlock, signature: `summary-${++summaries}` }], "compaction")),
          { headers: { "content-type": "text/event-stream" } },
        );
      const blocks = [
        thought,
        { type: "text", text: "progress", citations: null },
        {
          type: "tool_use",
          id: `call-${++replies}`,
          name: "shell",
          input: {},
          caller: { type: "direct" },
          future_tool: "opaque",
        },
      ];
      nativeReplies.push(blocks);
      return new Response(wire(message(blocks, "tool_use", `reply-${replies}`)), {
        headers: { "content-type": "text/event-stream" },
      });
    },
  });
  const input = initial(),
    runId = "run-fixture";
  let state: NativeContextState | undefined;
  try {
    for (let round = 1; round <= 3; round++) {
      const result = await f.provider.nativeContext.respond({
        runId,
        input,
        tools: [fixtureTool],
        signal: signal(),
        clock: `clock-${round}`,
        ...(state ? { state } : {}),
      });
      state = result.state;
      addReply(input, result.response.output);
      input.push(
        { type: "function_call_output", call_id: `call-${round}`, output: `result-${round}` },
        {
          role: "user",
          content: [
            {
              type: "input_image",
              image_url: `https://example.com/frame-${round}.png`,
              detail: "original",
            },
          ],
        },
      );
      if (round === 1)
        input.push({ role: "system", content: JSON.stringify({ kind: "revision", value: 2 }) });
    }
    if (!state) throw new TypeError("missing state");
    const before = structuredClone(input),
      third = f.requests[2];
    const compacted = await f.provider.nativeContext.compact({
      runId,
      input,
      tools: [fixtureTool],
      state,
      signal: signal(),
    });
    if (!compacted) throw new TypeError("missing compacted state");
    expect(input).toEqual(before);
    expect(f.requests[3]?.messages).toEqual(f.requests[1]?.messages);
    const restored = NativeContextState.parse(JSON.parse(JSON.stringify(compacted)));
    const restarted = f.makeProvider();
    const next = await restarted.nativeContext.respond({
      runId,
      input,
      tools: [fixtureTool],
      state: restored,
      signal: signal(),
      clock: "clock-4",
    });
    const continuation = f.requests[4];
    expect(continuation?.system).toEqual(f.requests[0]?.system);
    expect(continuation?.tools).toEqual(f.requests[0]?.tools);
    expect(continuation?.messages[0]?.content).toEqual([
      { ...summaryBlock, signature: "summary-1" },
    ]);
    expect(continuation?.messages.slice(1, 4)).toEqual(third?.messages.slice(-3));
    expect(continuation?.messages[1]?.content).toEqual(nativeReplies[1]);
    expect(JSON.stringify(continuation)).not.toContain("frame-1.png");
    expect(JSON.stringify(continuation)).toContain("frame-3.png");
    addReply(input, next.response.output);
    input.push({ type: "function_call_output", call_id: "call-4", output: "four" });
    const again = await restarted.nativeContext.compact({
      runId,
      input,
      tools: [fixtureTool],
      state: next.state,
      signal: signal(),
    });
    if (!again) throw new TypeError("missing second summary");
    await restarted.nativeContext.respond({
      runId,
      input,
      tools: [fixtureTool],
      state: again,
      signal: signal(),
      clock: "clock-5",
    });
    const last = f.requests.at(-1);
    expect(JSON.stringify(last)).not.toContain("summary-1");
    expect(JSON.stringify(last)).toContain("summary-2");
    expect(last?.messages[0]?.content).toEqual([{ ...summaryBlock, signature: "summary-2" }]);
    await Bun.write(
      ".omo/evidence/claude-native-context/provider-wire.json",
      JSON.stringify({ headers: f.headers, requests: f.requests }, null, 2),
    );
  } finally {
    await f.close();
  }
});

for (const invalid of ["null", "empty", "signature", "stop", "tool", "model", "truncated"] as const)
  test(`invalid ${invalid} compaction preserves original state`, async () => {
    const f = fixture({
      respond: (body) => {
        let block: unknown = summaryBlock;
        if (invalid === "null") block = { ...summaryBlock, content: null };
        if (invalid === "empty") block = { ...summaryBlock, content: "" };
        if (invalid === "signature") block = { type: "compaction", content: "fixture" };
        if (invalid === "tool")
          block = { type: "tool_use", id: "unexpected", name: "shell", input: {} };
        const result = body.compaction
          ? message(
              [block],
              invalid === "stop" ? "end_turn" : "compaction",
              "summary",
              invalid === "model" ? "foreign" : model,
            )
          : message([{ type: "text", text: "done" }]);
        return new Response(wire(result, !body.compaction || invalid !== "truncated"), {
          headers: { "content-type": "text/event-stream" },
        });
      },
    });
    const input = initial();
    try {
      const result = await f.provider.nativeContext.respond({
        runId: "run",
        input,
        tools: [],
        signal: signal(),
        clock: "clock",
      });
      addReply(input, result.response.output);
      input.push({ role: "user", content: "next" });
      const before = JSON.stringify(result.state);
      await expect(
        f.provider.nativeContext.compact({
          runId: "run",
          input,
          tools: [],
          state: result.state,
          signal: signal(),
        }),
      ).rejects.toThrow();
      expect(JSON.stringify(result.state)).toBe(before);
    } finally {
      await f.close();
    }
  });

for (const change of ["tools", "system", "model", "run"] as const)
  test(`changed ${change} refuses retained native history before sending`, async () => {
    const f = fixture(),
      input = initial();
    try {
      const result = await f.provider.nativeContext.respond({
        runId: "run",
        input,
        tools: [],
        signal: signal(),
        clock: "clock",
      });
      addReply(input, result.response.output);
      input.push({ role: "user", content: "next" });
      if (change === "system") input[0] = { role: "system", content: "changed" };
      const state = change === "model" ? { ...result.state, model: "foreign" } : result.state;
      await expect(
        f.provider.nativeContext.respond({
          runId: change === "run" ? "other" : "run",
          input,
          tools: change === "tools" ? [fixtureTool] : [],
          state,
          signal: signal(),
          clock: "clock-2",
        }),
      ).rejects.toBeInstanceOf(NativeContextError);
      expect(f.requests).toHaveLength(1);
    } finally {
      await f.close();
    }
  });

test("Claude exposes an explicit native-context capability path", () => {
  // Given a provider constructed without reading any real credentials.
  const provider = new AnthropicProvider(
    { model: "claude-opus-5-5", apiKey: "fixture" },
    new Anthropic({ apiKey: "fixture", baseURL: "http://127.0.0.1:1", maxRetries: 0 }),
  );
  // When checking the provider contract, no network call is necessary.
  const available = "nativeContext" in provider;
  // Then callers can request a typed capability result before enabling the lane.
  expect(available).toBe(true);
});

for (const mode of ["abort", "close"] as const)
  test(`native summarize ${mode} rejects a late completed response without changing state`, async () => {
    const entered = Promise.withResolvers<void>(),
      release = Promise.withResolvers<void>();
    const f = fixture({
      respond: async (body) => {
        if (body.compaction) {
          entered.resolve();
          await release.promise;
        }
        return new Response(
          wire(
            message(
              body.compaction ? [summaryBlock] : [{ type: "text", text: "done" }],
              body.compaction ? "compaction" : "end_turn",
            ),
          ),
          { headers: { "content-type": "text/event-stream" } },
        );
      },
    });
    const input = initial();
    try {
      const result = await f.provider.nativeContext.respond({
        runId: "run",
        input,
        tools: [],
        signal: signal(),
        clock: "clock",
      });
      addReply(input, result.response.output);
      input.push({ role: "user", content: "next" });
      const before = structuredClone(result.state),
        abort = new AbortController();
      const pending = f.provider.nativeContext.compact({
        runId: "run",
        input,
        tools: [],
        state: result.state,
        signal: abort.signal,
      });
      const rejected = pending.then(
        () => undefined,
        (error: unknown) => error,
      );
      await entered.promise;
      if (mode === "abort") abort.abort();
      else f.provider.close();
      release.resolve();
      expect(await rejected).toBeInstanceOf(Error);
      expect(result.state).toEqual(before);
      expect(f.requests).toHaveLength(2);
    } finally {
      release.resolve();
      await f.close();
    }
  });

test("native continuation rejects server-reported thinking transformations", async () => {
  const f = fixture({
    respond: () => {
      const result = {
        ...message([{ type: "text", text: "done" }]),
        input_transformations: [
          {
            type: "thinking_dropped",
            path: "messages.1.content.0",
            reason: "prefix_binding_mismatch",
          },
        ],
      };
      return new Response(wire(result), { headers: { "content-type": "text/event-stream" } });
    },
  });
  try {
    await expect(
      f.provider.nativeContext.respond({
        runId: "run",
        input: initial(),
        tools: [],
        signal: signal(),
        clock: "clock",
      }),
    ).rejects.toThrow("Claude changed signed thinking ancestry");
  } finally {
    await f.close();
  }
});
