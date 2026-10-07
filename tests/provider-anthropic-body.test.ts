import { expect, test } from "bun:test";
import { fixture } from "./anthropic-context-fixture.ts";
import {
  CLAUDE_REQUEST_BYTES,
  nativeMessageBody,
} from "../packages/provider/anthropic-context-wire.ts";
import { prepareNative } from "../packages/provider/anthropic-context-frames.ts";
import type { ResponseInputItem } from "../packages/provider/index.ts";

test("fresh oversized Claude wire is rejected before token counting or inference", async () => {
  // Given new input already exceeds the documented request byte limit.
  const f = fixture();
  try {
    const request = {
      runId: "run",
      input: [{ role: "user" as const, content: "x".repeat(32_000_000) }],
      tools: [],
      signal: new AbortController().signal,
      clock: "clock",
    };
    // When preparing the token-count request.
    await expect(f.provider.nativeContext.measure(request)).rejects.toThrow();
    // Then no oversized body crossed the HTTP boundary.
    expect(f.counts).toHaveLength(0);
    expect(f.requests).toHaveLength(0);
  } finally {
    await f.close();
  }
});

test("exact32MB streaming body is admitted and the next byte is refused before HTTP", async () => {
  const f = fixture(),
    signal = new AbortController().signal;
  try {
    const input: ResponseInputItem[] = [{ role: "user", content: "x" }];
    const request = { runId: "run", input, tools: [], signal, clock: "clock" };
    const overhead =
      Buffer.byteLength(
        JSON.stringify(
          nativeMessageBody(request, prepareNative(request, "claude-opus-5-5"), 16384),
        ),
      ) - 1;
    input[0] = { role: "user", content: "x".repeat(CLAUDE_REQUEST_BYTES - overhead) };
    await f.provider.nativeContext.measure(request);
    await f.provider.nativeContext.respond(request);
    expect(f.bodyBytes.at(-1)?.bytes).toBe(CLAUDE_REQUEST_BYTES);
    const count = f.bodyBytes.length;
    input[0] = { role: "user", content: "x".repeat(CLAUDE_REQUEST_BYTES - overhead + 1) };
    await expect(f.provider.nativeContext.measure(request)).rejects.toThrow(
      "request_body_too_large",
    );
    await expect(f.provider.nativeContext.respond(request)).rejects.toThrow(
      "request_body_too_large",
    );
    expect(f.bodyBytes).toHaveLength(count);
    await Bun.write(
      ".omo/evidence/claude-bounded-context/body-boundary.json",
      JSON.stringify({ limit: CLAUDE_REQUEST_BYTES, transmitted: f.bodyBytes }, null, 2),
    );
  } finally {
    await f.close();
  }
}, 15000);

test("base64 expansion is included in byte admission", async () => {
  const f = fixture();
  try {
    const raw = Buffer.alloc(24_000_000);
    await expect(
      f.provider.nativeContext.measure({
        runId: "run",
        input: [
          {
            role: "user",
            content: [
              {
                type: "input_image",
                image_url: `data:image/png;base64,${raw.toString("base64")}`,
                detail: "original",
              },
            ],
          },
        ],
        tools: [],
        signal: new AbortController().signal,
        clock: "clock",
      }),
    ).rejects.toThrow("request_body_too_large");
    expect(f.bodyBytes).toHaveLength(0);
  } finally {
    await f.close();
  }
});

test("wire admission counts UTF8 bytes rather than JavaScript characters", async () => {
  const f = fixture();
  try {
    await expect(
      f.provider.nativeContext.measure({
        runId: "run",
        input: [{ role: "user", content: "한".repeat(10_666_667) }],
        tools: [],
        signal: new AbortController().signal,
        clock: "clock",
      }),
    ).rejects.toThrow("request_body_too_large");
    expect(f.bodyBytes).toHaveLength(0);
  } finally {
    await f.close();
  }
});
