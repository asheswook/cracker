import { expect, test } from "bun:test";
import OpenAI from "openai";
import Anthropic from "@anthropic-ai/sdk";
import ky, { TimeoutError } from "ky";
import { advertisedWait, backgroundRetry, foregroundRetry, retryProvider, type ProviderRetryDecision } from "../packages/provider/retry.ts";
import { ProviderError } from "../packages/provider/errors.ts";

const signal = () => new AbortController().signal;
for (const sdk of [OpenAI, Anthropic]) for (const status of [408, 429, 500, 502, 503, 504, 529])
  test(`${sdk.name} status ${status} enters bounded retry`, async () => {
    // Given
    const controller = new AbortController(), decisions: ProviderRetryDecision[] = [];
    const error = sdk.APIError.generate(status, {}, "synthetic", new Headers());
    // When aborting from the retry callback avoids wall-clock backoff in classification tests.
    await expect(retryProvider(async () => { throw error; }, { signal: controller.signal, onRetry: decision => { decisions.push(decision); controller.abort(); } })).rejects.toThrow();
    // Then
    expect(decisions).toHaveLength(1); expect(decisions[0]).toMatchObject({ attempt: 1, status, reason: "http_transient" });
  });

for (const error of [new OpenAI.APIConnectionError({}), new Anthropic.APIConnectionError({}), new OpenAI.APIConnectionTimeoutError(), new Anthropic.APIConnectionTimeoutError(), new TimeoutError(new Request("http://127.0.0.1/")), new ProviderError("incomplete", "Provider completed without output"), new ProviderError("incomplete", "Claude stream ended before message_stop")])
  test(`recognized transport error ${error.constructor.name}: ${error.message} retries`, async () => {
    // Given
    const controller = new AbortController(); let notices = 0;
    // When
    await expect(retryProvider(async () => { throw error; }, { signal: controller.signal, onRetry: () => { notices++; controller.abort(); } })).rejects.toThrow();
    // Then
    expect(notices).toBe(1);
  });

for (const error of [
  ...[400, 401, 403, 404, 422].flatMap(status => [OpenAI.APIError.generate(status, { error: "invalid_grant" }, "synthetic", new Headers()), Anthropic.APIError.generate(status, {}, "synthetic", new Headers())]),
  new ProviderError("configuration", "missing credential"), new ProviderError("oauth", "invalid_grant"),
  new ProviderError("incomplete", "Claude changed signed thinking ancestry"),
  new ProviderError("incomplete", "Claude stop reason does not match its output"),
  new ProviderError("incomplete", "WebSocket response failed validation or transport"),
  new ProviderError("incomplete", "WebSocket request aborted"),
  new ProviderError("incomplete", "WebSocket transport failed", { http_status: null, api_code: "invalid_api_key", parameter: null, message_category: "unknown", mentioned_parameters: [] }), new Error("arbitrary tool failure"), new TypeError("invalid schema"),
]) test(`permanent ${error.constructor.name}: ${error.message} is not retried`, async () => {
  // Given
  let calls = 0, notices = 0;
  // When
  await expect(retryProvider(async () => { calls++; throw error; }, { signal: signal(), onRetry: () => { notices++; } })).rejects.toBe(error);
  // Then
  expect(calls).toBe(1); expect(notices).toBe(0);
});

test("persistent transient errors stop at the budget's attempt limit with jittered exponential delays", async () => {
  // Given a tiny budget so the test does not sleep for real backoff.
  const error = new OpenAI.APIConnectionError({}); let calls = 0;
  const notices: ProviderRetryDecision[] = [];
  // When
  await expect(retryProvider(async () => { calls++; throw error; }, { signal: signal(), onRetry: notice => notices.push(notice), budget: { attempts: 4, totalMs: 60_000, maxDelayMs: 30_000 } })).rejects.toBe(error);
  // Then
  expect(calls).toBe(4); expect(notices.map(n => n.attempt)).toEqual([1, 2, 3]);
  expect(notices[0]?.delayMs).toBeGreaterThanOrEqual(500); expect(notices[0]?.delayMs).toBeLessThanOrEqual(1000);
  expect(notices[1]?.delayMs).toBeGreaterThanOrEqual(1000); expect(notices[1]?.delayMs).toBeLessThanOrEqual(2000);
}, 60000);
test("default budgets: foreground rides out short outages, background waits out long rate windows", () => {
  expect(foregroundRetry.attempts).toBeGreaterThanOrEqual(6);
  expect(backgroundRetry.totalMs).toBeGreaterThanOrEqual(10 * 60_000);
  expect(backgroundRetry.attempts).toBeGreaterThan(foregroundRetry.attempts);
});
test("server-advertised waits come from retry-after-ms, retry-after, codex and OpenAI reset headers", () => {
  const now = Date.parse("2026-10-14T00:00:00Z");
  expect(advertisedWait(new Headers({ "retry-after-ms": "1500" }), now)).toBe(1500);
  expect(advertisedWait(new Headers({ "retry-after": "3" }), now)).toBe(3000);
  expect(advertisedWait(new Headers({ "retry-after": new Date(now + 4000).toUTCString() }), now)).toBe(4000);
  expect(advertisedWait(new Headers({ "x-codex-primary-reset-after-seconds": "120", "x-codex-secondary-reset-after-seconds": "30" }), now)).toBe(120000);
  expect(advertisedWait(new Headers({ "x-ratelimit-reset-requests": "1m3.5s" }), now)).toBe(63500);
  expect(advertisedWait(new Headers({ "anthropic-ratelimit-unified-reset": String(now / 1000 + 90) }), now)).toBe(90000);
  expect(advertisedWait(new Headers({ "retry-after": "soon" }), now)).toBeUndefined();
});
test("codex usage_limit_reached waits until resets_at under the background budget and is never retried early", async () => {
  const resetsAt = Math.floor(Date.now() / 1000) + 2;
  const error = OpenAI.APIError.generate(429, { error: { type: "usage_limit_reached", resets_at: resetsAt } }, "limit", new Headers());
  const controller = new AbortController(), notices: ProviderRetryDecision[] = [];
  await expect(retryProvider(async () => { throw error; }, { signal: controller.signal, budget: backgroundRetry, onRetry: n => { notices.push(n); controller.abort(); } })).rejects.toThrow();
  expect(notices[0]?.reason).toBe("usage_limit");
  expect(notices[0]?.delayMs).toBeGreaterThanOrEqual(1000);
  let calls = 0;
  const far = OpenAI.APIError.generate(429, { error: { type: "usage_limit_reached", resets_at: Math.floor(Date.now() / 1000) + 7200 } }, "limit", new Headers());
  await expect(retryProvider(async () => { calls++; throw far; }, { signal: signal(), budget: backgroundRetry })).rejects.toBe(far);
  expect(calls).toBe(1);
});

for (const retryAfter of ["120", new Date(Date.now() + 180000).toUTCString()]) test(`Retry-After ${retryAfter} beyond budget is never retried early`, async () => {
  // Given
  const error = OpenAI.APIError.generate(429, {}, "synthetic", new Headers({ "retry-after": retryAfter })); let calls = 0;
  // When
  await expect(retryProvider(async () => { calls++; throw error; }, { signal: signal() })).rejects.toBe(error);
  // Then
  expect(calls).toBe(1);
});

test("short Retry-After is a minimum delay and retry decisions contain only bounded metadata", async () => {
  // Given
  const controller = new AbortController(), notices: ProviderRetryDecision[] = [];
  const error = OpenAI.APIError.generate(429, { token: "secret" }, "secret upstream URL", new Headers({ "retry-after": "2" }));
  // When
  await expect(retryProvider(async () => { throw error; }, { signal: controller.signal, onRetry: n => { notices.push(n); controller.abort(); } })).rejects.toThrow();
  // Then
  expect(notices).toEqual([{ attempt: 1, delayMs: 2000, reason: "http_transient", status: 429 }]);
});

test("abort interrupts pending backoff before another attempt", async () => {
  // Given
  const controller = new AbortController(); let calls = 0;
  // When
  const began = performance.now();
  await expect(retryProvider(async () => { calls++; throw new OpenAI.APIConnectionError({}); }, { signal: controller.signal, onRetry: () => { setTimeout(() => controller.abort(), 5); } })).rejects.toThrow();
  // Then
  expect(calls).toBe(1); expect(performance.now() - began).toBeLessThan(250);
});

test("ky credential-refresh transient HTTP error retries without replaying an authentication error", async () => {
  // Given a real HTTP boundary with ky retries disabled.
  let calls = 0;
  const server = Bun.serve({ hostname: "127.0.0.1", port: 0, fetch: () => { calls++; return Response.json({ error: "synthetic" }, { status: calls === 1 ? 503 : 400 }); } });
  try {
    // When
    await expect(retryProvider(() => ky.get(server.url, { retry: 0 }).json(), { signal: signal() })).rejects.toMatchObject({ response: { status: 400 } });
    // Then
    expect(calls).toBe(2);
  } finally { server.stop(true); }
});

for (const wire of [
  { code: "server_error", type: "server_error" },
  { code: "rate_limit_exceeded", type: "rate_limit_error" },
  { code: "unrecognized_future_code", type: "unrecognized_future_type" },
  {},
]) test(`status-less SDK failure ${JSON.stringify(wire)} enters bounded retry`, async () => {
  // Given the status-less APIError shape emitted by the SDK's HTTP200 SSE parser.
  const controller = new AbortController(), decisions: ProviderRetryDecision[] = [];
  const error = new OpenAI.APIError(undefined, wire, "untrusted fixture message", new Headers());
  try {
    // When classification reaches retry, aborting the observer avoids arbitrary test delays.
    await expect(retryProvider(async () => { throw error; }, { signal: controller.signal, onRetry: decision => { decisions.push(decision); controller.abort(); } })).rejects.toThrow();
    // Then absence of HTTP status does not suppress an inference retry.
    expect(decisions).toHaveLength(1);
    expect(decisions[0]?.attempt).toBe(1);
    expect(decisions[0]?.status).toBeUndefined();
  } finally { controller.abort(); }
});

for (const code of ["invalid_api_key", "authentication_error", "permission_denied", "insufficient_quota", "billing_hard_limit_reached", "model_not_found", "unsupported_parameter", "context_length_exceeded", "content_filter"]) {
  for (const discriminator of ["code", "type"] as const) test(`permanent status-less ${discriminator}=${code} overrides transient metadata`, async () => {
    // Given a permanent discriminator even though its sibling suggests a server failure.
    const wire = discriminator === "code" ? { code, type: "server_error" } : { code: "server_error", type: code };
    const error = new OpenAI.APIError(undefined, wire, "fixture", new Headers());
    let attempts = 0;
    // When the retry policy sees the structured permanent failure.
    await expect(retryProvider(async () => { attempts++; throw error; }, { signal: signal() })).rejects.toBe(error);
    // Then auth, configuration, quota and request-limit failures are not replayed.
    expect(attempts).toBe(1);
  });
}
