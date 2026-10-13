import OpenAI from 'openai';
import Anthropic from '@anthropic-ai/sdk';
import { HTTPError, TimeoutError } from 'ky';
import { z } from 'zod';
import { ProviderError } from '../../packages/provider/errors.ts';
import { CredentialError } from '../../packages/provider/credentials.ts';
import { providerFailure } from '../../packages/provider/diagnostic.ts';
import { apiFailure, ProviderStreamError, type ApiFailure } from '../../packages/provider/api-failure.ts';

export type InfrastructureFailure = Partial<ApiFailure> & {
  readonly code: string;
  readonly exception: 'OpenAIAPIError' | 'AnthropicAPIError' | 'APIConnectionError' |
    'APIConnectionTimeoutError' | 'HTTPError' | 'TimeoutError' | 'ProviderError' | 'CredentialError' | 'ProviderStreamError';
  readonly http_status?: number;
  readonly provider_reason?: string;
};

export function infrastructureFailure(error: unknown): InfrastructureFailure | undefined {
  if (error instanceof OpenAI.APIConnectionTimeoutError || error instanceof Anthropic.APIConnectionTimeoutError)
    return { code: 'provider_timeout', exception: 'APIConnectionTimeoutError' };
  if (error instanceof OpenAI.APIConnectionError || error instanceof Anthropic.APIConnectionError)
    return { code: 'provider_connection_error', exception: 'APIConnectionError' };
  if (error instanceof OpenAI.APIError || error instanceof Anthropic.APIError) {
    const status = z.number().int().min(100).max(599).safeParse(error.status);
    return { code: status.success?'provider_http_error':'provider_stream_error', exception: error instanceof OpenAI.APIError ? 'OpenAIAPIError' : 'AnthropicAPIError',...apiFailure(error),
      ...(status.success ? { http_status: status.data } : {}) };
  }
  if(error instanceof ProviderStreamError)return {code:'provider_stream_error',exception:'ProviderStreamError',...error.failure};
  if (error instanceof HTTPError) return { code: 'http_error', exception: 'HTTPError', http_status: error.response.status };
  if (error instanceof TimeoutError) return { code: 'http_timeout', exception: 'TimeoutError' };
  if (error instanceof CredentialError) return { code: 'credential_error', exception: 'CredentialError' };
  if (error instanceof ProviderError) {
    const code = z.enum(['configuration', 'incomplete', 'oauth']).safeParse(error.code);
    return { code: code.success ? `provider_${code.data}` : 'provider_error', exception: 'ProviderError', provider_reason: providerFailure(error).reason };
  }
  return undefined;
}
