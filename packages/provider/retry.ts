import OpenAI from "openai";
import Anthropic from "@anthropic-ai/sdk";
import { HTTPError, TimeoutError } from "ky";
import { setTimeout as delay } from "node:timers/promises";
import { ProviderError } from "./errors.ts";
import { apiFailure, type ApiFailure } from './api-failure.ts';

export type ProviderRetryDecision = {
  readonly attempt: number;
  readonly delayMs: number;
  readonly reason: "http_transient" | "connection" | "timeout" | "incomplete_stream" | "provider_stream_error";
  readonly status?: number;
  readonly diagnostic?: ApiFailure;
};
export type ProviderRetryObserver = (decision: ProviderRetryDecision) => void;
type Transient = Pick<ProviderRetryDecision, "reason" | "status" | "diagnostic"> & { readonly retryAfter?: string | null };
const transientStatus = (status: number) => status === 408 || status === 429 || (status >= 500 && status <= 599);
const streamFailures = new Set([
  "Provider completed without output", "Provider stream ended before response.completed",
  "Claude stream ended before message_stop", "WebSocket closed before completion",
]);

function transient(error: unknown): Transient | undefined {
  if (error instanceof OpenAI.APIConnectionTimeoutError || error instanceof Anthropic.APIConnectionTimeoutError || error instanceof TimeoutError)
    return { reason: "timeout" };
  if (error instanceof OpenAI.APIConnectionError || error instanceof Anthropic.APIConnectionError)
    return { reason: "connection" };
  const diagnostic = apiFailure(error);
  if (diagnostic) {
    if (!diagnostic.retryable) return undefined;
    if (error instanceof OpenAI.APIError && error.status !== undefined)
      return { reason: 'http_transient', status: error.status, retryAfter: error.headers?.get('retry-after') };
    return { reason: 'provider_stream_error', diagnostic };
  }
  if (error instanceof Anthropic.APIError) {
    if (error.status !== undefined && transientStatus(error.status))
      return { reason: "http_transient", status: error.status, retryAfter: error.headers?.get("retry-after") };
    return undefined;
  }
  if (error instanceof HTTPError)
    return transientStatus(error.response.status)
      ? { reason: "http_transient", status: error.response.status, retryAfter: error.response.headers.get("retry-after") }
      : undefined;
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
  options: { readonly signal: AbortSignal; readonly onRetry?: ProviderRetryObserver | undefined },
): Promise<T> {
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
      if (!failure || attempt >= 5) throw error;
      const raw = failure.retryAfter?.trim();
      const seconds = raw && /^\d+(?:\.\d+)?$/.test(raw) ? Number(raw) : undefined;
      const retryAfter = seconds !== undefined ? seconds * 1000 : raw ? Date.parse(raw) - Date.now() : 0;
      const delayMs = Math.max(500 * 2 ** attempt * (0.5 + Math.random()), Number.isNaN(retryAfter) ? 0 : retryAfter);
      // A long task should ride out a brief provider outage instead of stopping; a server asking for longer
      // than the total wait budget is never retried early.
      if (delayMs > 45000 - waitedMs) throw error;
      const { reason, status, diagnostic } = failure;
      options.onRetry?.({ attempt: attempt + 1, delayMs, reason, ...(status === undefined ? {} : { status }), ...(diagnostic ? { diagnostic } : {}) });
      options.signal.throwIfAborted();
      await delay(delayMs, undefined, { signal: options.signal });
      waitedMs += delayMs;
    }
  }
}
