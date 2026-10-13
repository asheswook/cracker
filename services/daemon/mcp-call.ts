import { ErrorCode, McpError } from '@modelcontextprotocol/sdk/types.js';
import { UnauthorizedError } from '@modelcontextprotocol/sdk/client/auth.js';
import { StreamableHTTPError } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import { SseError } from '@modelcontextprotocol/sdk/client/sse.js';
import { setTimeout as delay } from 'node:timers/promises';

export type McpCallCode = 'timeout' | 'authentication_failed' | 'access_denied' | 'rate_limited' |
  'server_unavailable' | 'connection_closed' | 'invalid_arguments' | 'tool_unavailable' | 'mcp_call_failed';
type Failure = { readonly code: McpCallCode; readonly transient: boolean; readonly http_status?: number; readonly rpc_code?: number };
export type McpCallEvent = {
  readonly event: 'mcp.call.retry' | 'mcp.call.error'; readonly code: McpCallCode;
  readonly attempt: number; readonly read_only: boolean; readonly duration_ms: number;
  readonly http_status?: number; readonly rpc_code?: number;
};
const connectionCodes = new Set(['ECONNRESET','ECONNREFUSED','EPIPE','ENOTFOUND','EAI_AGAIN','UND_ERR_SOCKET']);
function classify(error: unknown): Failure {
  if (error instanceof UnauthorizedError) return { code: 'authentication_failed', transient: false };
  if (error instanceof StreamableHTTPError || error instanceof SseError) {
    const http_status = error.code;
    switch (http_status) {
      case 401: return { code: 'authentication_failed', transient: false, http_status };
      case 403: return { code: 'access_denied', transient: false, http_status };
      case 408: return { code: 'timeout', transient: true, http_status };
      case 429: return { code: 'rate_limited', transient: true, http_status };
      case 404: return { code: 'connection_closed', transient: true, http_status };
      case 405: return { code: 'tool_unavailable', transient: false, http_status };
    }
    if (http_status !== undefined && http_status >= 500 && http_status <= 599)
      return { code: 'server_unavailable', transient: true, http_status };
  }
  if (error instanceof McpError) {
    const rpc_code = error.code;
    switch (rpc_code) {
      case ErrorCode.RequestTimeout: return { code: 'timeout', transient: true, rpc_code };
      case ErrorCode.ConnectionClosed: return { code: 'connection_closed', transient: true, rpc_code };
      case ErrorCode.InvalidParams: return { code: 'invalid_arguments', transient: false, rpc_code };
      case ErrorCode.MethodNotFound: return { code: 'tool_unavailable', transient: false, rpc_code };
      case ErrorCode.InternalError: return { code: 'server_unavailable', transient: true, rpc_code };
      default: return { code: 'mcp_call_failed', transient: false, rpc_code };
    }
  }
  if (error instanceof Error && error.message === 'Not connected')
    return { code: 'connection_closed', transient: true };
  let cause:unknown=error;
  for(let depth=0;depth<3&&cause instanceof Error;depth++){
    if('code' in cause&&typeof cause.code==='string'){
      if(connectionCodes.has(cause.code))return {code:'connection_closed',transient:true};
      if(['ETIMEDOUT','UND_ERR_CONNECT_TIMEOUT','UND_ERR_HEADERS_TIMEOUT','UND_ERR_BODY_TIMEOUT'].includes(cause.code))return {code:'timeout',transient:true};
    }
    cause=cause.cause;
  }
  return { code: 'mcp_call_failed', transient: false };
}
export function staleMcpConnection(error: unknown): boolean {
  const failure = classify(error);
  return failure.code === 'connection_closed' || failure.code === 'timeout';
}
export function mcpErrorResult(failure: {
  readonly code: McpCallCode; readonly message: string; readonly attempts: number;
  readonly readOnly: boolean; readonly retryable: boolean;
}): string {
  return JSON.stringify({ isError: true, content: [{ type: 'text', text: JSON.stringify({
    kind: 'mcp_call_error', code: failure.code, message: failure.message, attempts: failure.attempts,
    read_only: failure.readOnly, effect_uncertain: !failure.readOnly, retryable: failure.retryable,
    retry_safety: failure.readOnly ? 'read_only' : 'reconcile_before_retry',
  }) }] });
}
export async function callMcp<T>(request: (timeoutMs: number) => Promise<T>, options: {
  readonly signal: AbortSignal; readonly readOnly: boolean; readonly redact: (message: string) => string;
  readonly observe: (event: McpCallEvent) => void;
}): Promise<{ readonly ok: true; readonly result: T } | { readonly ok: false; readonly text: string }> {
  for (let attempt = 1; ; attempt++) {
    options.signal.throwIfAborted();
    const started = performance.now();
    try {
      const result = await request(attempt === 1 ? 120000 : 30000);
      options.signal.throwIfAborted();
      return { ok: true, result };
    } catch (error) {
      options.signal.throwIfAborted();
      const { transient, ...failure } = classify(error);
      const retry = options.readOnly && transient && attempt === 1;
      options.observe({ event: retry ? 'mcp.call.retry' : 'mcp.call.error', ...failure,
        attempt, read_only: options.readOnly, duration_ms: Math.round(performance.now() - started) });
      if (retry) { await delay(500, undefined, { signal: options.signal }); continue; }
      const message = options.redact(error instanceof Error ? error.message : 'Unrecognized MCP request failure').slice(0, 2000);
      return { ok: false, text: mcpErrorResult({ ...failure, message, attempts: attempt,
        readOnly: options.readOnly, retryable: options.readOnly && transient }) };
    }
  }
}
