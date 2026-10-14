import OpenAI from "openai";
import Anthropic from "@anthropic-ai/sdk";
import { HTTPError, TimeoutError } from "ky";
import { setTimeout as delay } from "node:timers/promises";
import { ProviderError } from "./errors.ts";
import { apiFailure, type ApiFailure } from './api-failure.ts';

export type ProviderRetryDecision = {
  readonly attempt: number;
  readonly delayMs: number;
  readonly reason: "http_transient" | "connection" | "timeout" | "incomplete_stream" | "provider_stream_error" | "usage_limit";
  readonly status?: number;
  readonly diagnostic?: ApiFailure;
};
export type ProviderRetryObserver = (decision: ProviderRetryDecision) => void;
export type RetryBudget = { readonly attempts: number; readonly totalMs: number; readonly maxDelayMs: number };
export const foregroundRetry: RetryBudget = { attempts: 6, totalMs: 90_000, maxDelayMs: 30_000 };
export const backgroundRetry: RetryBudget = { attempts: 20, totalMs: 30 * 60_000, maxDelayMs: 5 * 60_000 };
type Transient = Pick<ProviderRetryDecision, "reason" | "status" | "diagnostic"> & { readonly waitMs?: number };
const transientStatus = (status: number) => status === 408 || status === 409 || status === 425 || status === 429 || (status >= 500 && status <= 599);
const streamFailures = new Set([
  "Provider completed without output", "Provider stream ended before response.completed",
  "Claude stream ended before message_stop", "WebSocket closed before completion",
]);

type HeaderSource = { get(name: string): string | null } | null | undefined;
function seconds(raw: string | null | undefined): number | undefined {
  const value = raw?.trim();
  return value && /^\d+(?:\.\d+)?$/.test(value) ? Number(value) * 1000 : undefined;
}
export function advertisedWait(headers: HeaderSource, now = Date.now()): number | undefined {
  if (!headers) return undefined;
  const ms = headers.get("retry-after-ms")?.trim();
  if (ms && /^\d+(?:\.\d+)?$/.test(ms)) return Number(ms);
  const retryAfter = headers.get("retry-after")?.trim();
  if (retryAfter) {
    const fromSeconds = seconds(retryAfter);
    if (fromSeconds !== undefined) return fromSeconds;
    const date = Date.parse(retryAfter);
    if (!Number.isNaN(date)) return Math.max(0, date - now);
  }
  const candidates = ["x-codex-primary-reset-after-seconds", "x-codex-secondary-reset-after-seconds", "anthropic-ratelimit-unified-reset", "x-ratelimit-reset-requests", "x-ratelimit-reset-tokens"]
    .map(name => [name, headers.get(name)?.trim()] as const)
    .flatMap(([name, value]) => {
      if (!value) return [];
      if (name.startsWith("x-codex")) { const wait = seconds(value); return wait === undefined ? [] : [wait]; }
      if (name === "anthropic-ratelimit-unified-reset") { const epoch = Number(value); return Number.isFinite(epoch) ? [Math.max(0, epoch * 1000 - now)] : []; }
      return durationMs(value);
    });
  return candidates.length ? Math.max(...candidates) : undefined;
}
/** OpenAI reset headers use Go-style durations such as "1m3.5s" or "250ms". */
function durationMs(value: string): number[] {
  if (!/^(?:\d+(?:\.\d+)?(?:ms|s|m|h))+$/.test(value)) return [];
  let total = 0;
  for (const [, amount, unit] of value.matchAll(/(\d+(?:\.\d+)?)(ms|s|m|h)/g)) total += Number(amount) * ({ ms: 1, s: 1000, m: 60_000, h: 3_600_000 } as const)[unit as "ms" | "s" | "m" | "h"];
  return [total];
}
function bodyResetWait(body: unknown, now = Date.now()): number | undefined {
  if (!body || typeof body !== "object") return undefined;
  const record = body as Record<string, unknown>;
  const nested = record["error"] && typeof record["error"] === "object" ? record["error"] as Record<string, unknown> : record;
  const resetsAt = nested["resets_at"] ?? nested["reset_at"];
  if (typeof resetsAt === "number" && Number.isFinite(resetsAt)) return Math.max(0, resetsAt * 1000 - now);
  const resetsIn = nested["resets_in_seconds"];
  if (typeof resetsIn === "number" && Number.isFinite(resetsIn)) return Math.max(0, resetsIn * 1000);
  return undefined;
}
function usageLimited(body: unknown): boolean {
  if (!body || typeof body !== "object") return false;
  const record = body as Record<string, unknown>;
  const nested = record["error"] && typeof record["error"] === "object" ? record["error"] as Record<string, unknown> : record;
  return [nested["type"], nested["code"]].some(value => typeof value === "string" && /usage_limit|rate_limit/.test(value));
}

function transient(error: unknown): Transient | undefined {
  if (error instanceof OpenAI.APIConnectionTimeoutError || error instanceof Anthropic.APIConnectionTimeoutError || error instanceof TimeoutError)
    return { reason: "timeout" };
  if (error instanceof OpenAI.APIConnectionError || error instanceof Anthropic.APIConnectionError)
    return { reason: "connection" };
  if (error instanceof OpenAI.APIError && usageLimited(error.error)) {
    const waitMs = advertisedWait(error.headers) ?? bodyResetWait(error.error);
    return { reason: "usage_limit", ...(error.status === undefined ? {} : { status: error.status }), ...(waitMs === undefined ? {} : { waitMs }) };
  }
  const diagnostic = apiFailure(error);
  if (diagnostic) {
    if (!diagnostic.retryable) return undefined;
    if (error instanceof OpenAI.APIError && error.status !== undefined) {
      const waitMs = advertisedWait(error.headers) ?? bodyResetWait(error.error);
      return { reason: 'http_transient', status: error.status, ...(waitMs === undefined ? {} : { waitMs }) };
    }
    return { reason: 'provider_stream_error', diagnostic };
  }
  if (error instanceof Anthropic.APIError) {
    if (error.status !== undefined && transientStatus(error.status)) {
      const waitMs = advertisedWait(error.headers);
      return { reason: "http_transient", status: error.status, ...(waitMs === undefined ? {} : { waitMs }) };
    }
    return undefined;
  }
  if (error instanceof HTTPError) {
    if (!transientStatus(error.response.status)) return undefined;
    const waitMs = advertisedWait(error.response.headers);
    return { reason: "http_transient", status: error.response.status, ...(waitMs === undefined ? {} : { waitMs }) };
  }
  if (error instanceof ProviderError && error.code === "incomplete") {
    if (streamFailures.has(error.message)) return { reason: "incomplete_stream" };
    if (error.message === "WebSocket request timed out") return { reason: "timeout" };
    if (error.message === "WebSocket transport failed") {
      const status = error.diagnostic?.http_status;
      if (status !== undefined && status !== null)
        return transientStatus(status) ? { reason: "http_transient", status } : undefined;
      if (!error.diagnostic || (error.diagnostic.message_category === "unknown" && error.diagnostic.api_code === null)) return { reason: "connection" };
    }
  }
  return undefined;
}

export async function retryProvider<T>(
  work: () => Promise<T>,
  options: { readonly signal: AbortSignal; readonly onRetry?: ProviderRetryObserver | undefined; readonly budget?: RetryBudget | undefined },
): Promise<T> {
  const budget = options.budget ?? foregroundRetry;
  let waitedMs = 0;
  for (let attempt = 0; ; attempt++) {
    options.signal.throwIfAborted();
    try {
      const result = await work();
      options.signal.throwIfAborted();
      return result;
    } catch (error) {
      options.signal.throwIfAborted();
      const failure = transient(error);
      if (!failure || attempt + 1 >= budget.attempts) throw error;
      // Full jitter on an exponential ceiling; a server-advertised wait is a floor, never shortened.
      const ceiling = Math.min(budget.maxDelayMs, 1000 * 2 ** attempt);
      const backoff = ceiling / 2 + Math.random() * ceiling / 2;
      const delayMs = Math.round(Math.max(backoff, failure.waitMs ?? 0));
      if (delayMs > budget.maxDelayMs && failure.waitMs !== undefined && failure.waitMs > budget.maxDelayMs) throw error;
      if (delayMs > budget.totalMs - waitedMs) throw error;
      const { reason, status, diagnostic } = failure;
      options.onRetry?.({ attempt: attempt + 1, delayMs, reason, ...(status === undefined ? {} : { status }), ...(diagnostic ? { diagnostic } : {}) });
      options.signal.throwIfAborted();
      await delay(delayMs, undefined, { signal: options.signal });
      waitedMs += delayMs;
    }
  }
}
