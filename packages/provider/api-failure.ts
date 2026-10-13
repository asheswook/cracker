import OpenAI from 'openai';
import { z } from 'zod';
import { createHash } from 'node:crypto';
import { ProviderError } from './errors.ts';

const Codes = z.enum([
  'server_error', 'internal_error', 'internal_server_error', 'rate_limit_exceeded', 'timeout',
  'request_timeout', 'overloaded_error', 'service_unavailable', 'temporarily_unavailable', 'vector_store_timeout',
  'invalid_request_error', 'invalid_api_key', 'invalid_grant', 'authentication_error', 'permission_denied',
  'insufficient_permissions', 'insufficient_scope', 'insufficient_quota', 'billing_hard_limit_reached',
  'invalid_model', 'model_not_found', 'unsupported_parameter', 'unsupported_value', 'invalid_value',
  'invalid_prompt', 'context_length_exceeded', 'max_output_tokens', 'content_filter', 'data_residency_mismatch', 'bio_policy',
]);
const Types = z.enum([
  'server_error', 'internal_error', 'rate_limit_error', 'overloaded_error', 'api_error',
  'invalid_request_error', 'authentication_error', 'permission_error', 'insufficient_quota', 'error',
]);
const Fields = z.object({ code: z.unknown().optional(), type: z.unknown().optional() });
const RequestId = z.string().regex(/^req_[a-zA-Z0-9_-]{1,128}$/);
const permanent = (value: string) => /^(invalid_|unsupported_|insufficient_|authentication|permission|billing_|context_length|model_not_found|content_filter|max_output_tokens|data_residency|bio_policy)/.test(value);
export type ApiFailure = {
  readonly api_code: string | null;
  readonly api_type: string | null;
  readonly request_id: string | null;
  readonly failure_fingerprint: string;
  readonly retryable: boolean;
  readonly event_type?: 'response.failed' | 'response.incomplete' | 'error';
  readonly incomplete_reason?: 'max_output_tokens' | 'content_filter' | 'unknown' | null;
};
export function describeApiFailure(body: unknown, message: string, requestId: unknown, status?: number): ApiFailure {
  const parsed = Fields.safeParse(body), fields = parsed.success ? parsed.data : {};
  const code = typeof fields.code === 'string' ? fields.code : null;
  const type = typeof fields.type === 'string' ? fields.type : null;
  const recognizedCode = Codes.safeParse(code), recognizedType = Types.safeParse(type);
  const rejected = [code, type].some(value => value !== null && permanent(value));
  const request = RequestId.safeParse(requestId);
  return {
    api_code: code === null ? null : recognizedCode.success ? recognizedCode.data : 'unknown',
    api_type: type === null ? null : recognizedType.success ? recognizedType.data : 'unknown',
    request_id: request.success ? request.data : null,
    failure_fingerprint: createHash('sha256').update(JSON.stringify({ code, type, message })).digest('hex'),
    retryable: !rejected && (status === undefined || status === 408 || status === 429 || (status >= 500 && status <= 599)),
  };
}
export class ProviderStreamError extends ProviderError {
  constructor(readonly failure: ApiFailure) {
    super('incomplete', 'Provider did not complete the response');
    this.name = 'ProviderStreamError';
  }
}
export function apiFailure(error: unknown): ApiFailure | undefined {
  if (error instanceof ProviderStreamError) return error.failure;
  if (error instanceof OpenAI.APIError) return describeApiFailure(error.error, error.message, error.requestID, error.status);
  return undefined;
}
