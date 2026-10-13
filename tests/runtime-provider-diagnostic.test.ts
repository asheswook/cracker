import { expect, test } from 'bun:test';
import OpenAI from 'openai';
import Anthropic from '@anthropic-ai/sdk';
import ky from 'ky';
import { Runtime, runtimeFailure } from '../services/daemon/runtime.ts';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { OpenAIProvider } from '../packages/provider/index.ts';
import { DaemonEvent, type Assignment } from '../packages/protocol/index.ts';
import { Journal } from '../services/daemon/journal.ts';
import { ToolExecutor } from '../services/daemon/tools.ts';
import { ProviderError } from '../packages/provider/errors.ts';
import { CredentialError } from '../packages/provider/credentials.ts';

const secret = 'private-value-must-never-appear';
test('runtime preserves SDK status and fixed exception identity without secret messages', () => {
  for (const [error, exception] of [
    [new OpenAI.APIError(503, { message: secret }, secret, new Headers({ 'authorization': secret })), 'OpenAIAPIError'],
    [new Anthropic.APIError(429, { message: secret }, secret, new Headers({ 'authorization': secret })), 'AnthropicAPIError'],
  ] as const) {
    const failure = runtimeFailure(crypto.randomUUID(), error);
    expect(failure).toMatchObject({ code: 'provider_http_error', exception, http_status: error.status });
    expect(JSON.stringify(failure)).not.toContain(secret);
  }
});

test('credential and incomplete-stream failures retain fixed actionable codes', () => {
  expect(runtimeFailure(crypto.randomUUID(), new CredentialError(secret)))
    .toMatchObject({ code: 'credential_error', exception: 'CredentialError' });
  expect(runtimeFailure(crypto.randomUUID(), new ProviderError('incomplete', 'Provider stream ended before response.completed')))
    .toMatchObject({ code: 'provider_incomplete', exception: 'ProviderError', provider_reason: 'stream_ended' });
  expect(JSON.stringify(runtimeFailure(crypto.randomUUID(), new ProviderError('incomplete', secret)))).not.toContain(secret);
});

test('actual HTTP rejection logs status without response body, URL or credentials', async () => {
  const server = Bun.serve({ port: 0, fetch: () => Response.json({ error: secret }, { status: 401 }) });
  try {
    try {
      await ky.get(new URL('/private?token=' + secret, server.url), { retry: 0 });
      throw new TypeError('Expected HTTP failure');
    } catch (error) {
      const failure = runtimeFailure(crypto.randomUUID(), error);
      expect(failure).toMatchObject({ code: 'http_error', exception: 'HTTPError', http_status: 401 });
      expect(JSON.stringify(failure)).not.toContain(secret);
      expect(JSON.stringify(failure)).not.toContain(server.url.host);
    }
  } finally { await server.stop(true); }
});

test('status-less SDK diagnostics preserve safe fields and discard untrusted payloads', () => {
  // Given the APIError shape produced by a real HTTP200 SSE error envelope.
  const error = new OpenAI.APIError(undefined, { code: 'server_error', type: 'server_error', message: secret, param: secret, url: 'https://private.example/' + secret }, secret, new Headers({ 'x-request-id': 'req_fixture_123', authorization: secret }));
  // When Runtime builds its persisted diagnostic.
  const failure = runtimeFailure(crypto.randomUUID(), error);
  // Then only approved structured metadata and an opaque fingerprint survive.
  expect(failure).toMatchObject({ code: 'provider_stream_error', exception: 'OpenAIAPIError', api_code: 'server_error', api_type: 'server_error', request_id: 'req_fixture_123', retryable: true });
  expect(JSON.stringify(failure)).not.toContain(secret);
  expect(JSON.stringify(failure)).not.toContain('private.example');
  expect(failure).toHaveProperty('failure_fingerprint', expect.stringMatching(/^[a-f0-9]{64}$/));
});

test('unknown SDK metadata and unsafe request IDs are fingerprinted without being logged', () => {
  // Given arbitrary provider-controlled discriminator, message and header values.
  const error = new OpenAI.APIError(undefined, { code: secret, type: secret, message: secret }, secret, new Headers({ 'x-request-id': 'https://private.example/' + secret, authorization: secret }));
  // When the same failure is categorized for two runtime records.
  const first = runtimeFailure(crypto.randomUUID(), error), second = runtimeFailure(crypto.randomUUID(), error);
  // Then raw fields remain absent while the fingerprint gives stable correlation.
  expect(first).toMatchObject({ code: 'provider_stream_error', api_code: 'unknown', api_type: 'unknown', request_id: null, retryable: true });
  expect(JSON.stringify(first)).not.toContain(secret);
  expect(JSON.stringify(first)).not.toContain('private.example');
  expect(first).toHaveProperty('failure_fingerprint', expect.stringMatching(/^[a-f0-9]{64}$/));
  expect(first).toHaveProperty('failure_fingerprint', Reflect.get(second, 'failure_fingerprint'));
});

class StreamRetryJournal extends Journal {
  readonly done = Promise.withResolvers<void>();
  override finish(run: string): void { super.finish(run); this.done.resolve(); }
}

test('status-less stream retry completes the same runtime run without replaying a real shell effect', async () => {
  // Given real SDK/control HTTP, SQLite, and a shell append that must execute once.
  const directory = await mkdtemp(join(tmpdir(), 'runtime-stream-retry-'));
  const effect = join(directory, 'effect.txt');
  const now = new Date().toISOString();
  const assignment: Assignment = { run_id: crypto.randomUUID(), task: { id: crypto.randomUUID(), conversation_id: crypto.randomUUID(), objective: 'stream retry fixture', state: 'running', reason: null, created_at: now, updated_at: now }, messages: [], instructions: '', memory: [] };
  let assigned = false;
  const events: DaemonEvent[] = [], bodies: string[] = [], failures: string[] = [];
  const control = Bun.serve({ hostname: '127.0.0.1', port: 0, async fetch(request) {
    const path = new URL(request.url).pathname;
    if (path === '/v1/daemon/extensions') return Response.json({ skills: [], servers: [] });
    if (path === '/v1/daemon/poll') { const next = assigned ? null : assignment; assigned = true; return Response.json({ assignment: next, commands: [], messages: [] }); }
    if (path === '/v1/daemon/events') { events.push(DaemonEvent.parse(await request.json())); return Response.json({ accepted: true }); }
    if (path === '/v1/daemon/composing') return Response.json({ generation: 1 });
    return Response.json({ messages: [] });
  } });
  const endpoint = Bun.serve({ hostname: '127.0.0.1', port: 0, async fetch(request) {
    bodies.push(await request.text());
    if (bodies.length === 2) return new Response(`event: error\ndata: ${JSON.stringify({ error: { code: 'server_error', type: 'server_error', message: 'fixture transient SSE failure' } })}\n\n`, { headers: { 'content-type': 'text/event-stream' } });
    const output = bodies.length === 1
      ? [{ type: 'function_call', id: 'tool_once', call_id: 'append_once', name: 'shell', arguments: JSON.stringify({ command: `printf once >> '${effect}'` }) }]
      : [{ type: 'message', id: 'final', role: 'assistant', status: 'completed', content: [{ type: 'output_text', text: 'finished once', annotations: [] }] }];
    return new Response(`data: ${JSON.stringify({ type: 'response.completed', response: { id: `resp_${bodies.length}`, status: 'completed', output } })}\n\n`, { headers: { 'content-type': 'text/event-stream' } });
  } });
  const provider = new OpenAIProvider({ mode: 'api', model: 'fixture', apiKey: 'fixture' }, new OpenAI({ apiKey: 'fixture', baseURL: endpoint.url.href, maxRetries: 9 }));
  const journal = new StreamRetryJournal(join(directory, 'journal.sqlite'));
  const runtime = new Runtime({ controlUrl: control.url.href, token: 'fixture', journal, provider, tools: new ToolExecutor(), artifactRoot: directory, onFailure: failure => failures.push(failure.code) });
  try {
    // When a post-tool inference returns an HTTP200 error frame.
    await runtime.tick(); await journal.done.promise; await runtime.flush();
    // Then inference recovers within the same run and the completed effect is untouched.
    expect(failures).toEqual([]);
    expect(await readFile(effect, 'utf8')).toBe('once');
    expect(bodies).toHaveLength(3);
    expect(bodies[1]).toBe(bodies[2]);
    expect(events.filter(event => event.kind === 'state').map(event => [event.run_id, event.state])).toEqual([[assignment.run_id, 'succeeded']]);
    expect(events.filter(event => event.kind === 'message').map(event => event.content)).toEqual(['finished once']);
    expect(journal.resumeSafe(assignment.run_id)).toBe(true);
  } finally { await runtime.stop(); provider.close(); await endpoint.stop(true); await control.stop(true); journal.close(); await rm(directory, { recursive: true, force: true }); }
});

for (const event of ['response.failed', 'response.incomplete', 'error'] as const) test(`actual ${event} exposes structured terminal diagnostics without provider prose`, async () => {
  // Given an actual SSE terminal event with an authentication failure or permanent limit.
  const remote = { code: 'invalid_api_key', type: 'authentication_error', message: secret };
  const value = event === 'error' ? { ...remote, type: event, sequence_number: 1 } : { type: event, response: { id: 'resp_terminal', output: [], error: remote, incomplete_details: event === 'response.incomplete' ? { reason: 'max_output_tokens' } : null } };
  let attempts = 0;
  const server = Bun.serve({ hostname: '127.0.0.1', port: 0, fetch() { attempts++; return new Response(`data: ${JSON.stringify(value)}\n\n`, { headers: { 'content-type': 'text/event-stream' } }); } });
  const provider = new OpenAIProvider({ mode: 'api', model: 'fixture', apiKey: 'fixture' }, new OpenAI({ apiKey: 'fixture', baseURL: server.url.href, maxRetries: 9 }));
  let diagnostic: ReturnType<typeof runtimeFailure> | undefined;
  try {
    // When stream decoding rejects the terminal result and Runtime categorizes it.
    try { await provider.respond([{ role: 'user', content: 'fixture' }], [], new AbortController().signal); }
    catch (error) { if (!(error instanceof ProviderError)) throw error; diagnostic = runtimeFailure(crypto.randomUUID(), error); }
    // Then the original event/code/type survive while the message does not.
    expect(diagnostic).toMatchObject({ code: 'provider_stream_error', event_type: event, api_code: 'invalid_api_key', api_type: event === 'error' ? 'error' : 'authentication_error', retryable: false });
    if (event === 'response.incomplete') expect(diagnostic).toMatchObject({ incomplete_reason: 'max_output_tokens' });
    expect(JSON.stringify(diagnostic)).not.toContain(secret);
    expect(attempts).toBe(1);
  } finally { provider.close(); await server.stop(true); }
});

test('unknown incomplete reason is sanitized and never retries a secret-bearing wire value', async () => {
  // Given a provider-controlled reason outside the SDK's declared literal union.
  const wireReason = `https://private.example/secret-${crypto.randomUUID()}`;
  let attempts = 0;
  const server = Bun.serve({ hostname: '127.0.0.1', port: 0, fetch() {
    attempts++;
    const event = { type: 'response.incomplete', response: { id: 'resp_unknown_reason', output: [], error: { code: 'server_error', message: 'fixture' }, incomplete_details: { reason: wireReason } } };
    return new Response(`data: ${JSON.stringify(event)}\n\n`, { headers: { 'content-type': 'text/event-stream' } });
  } });
  const provider = new OpenAIProvider({ mode: 'api', model: 'fixture', apiKey: 'fixture' }, new OpenAI({ apiKey: 'fixture', baseURL: server.url.href, maxRetries: 9 }));
  let diagnostic: ReturnType<typeof runtimeFailure> | undefined;
  try {
    // When the actual SDK parses the untrusted terminal response.
    try { await provider.respond([{ role: 'user', content: 'fixture' }], [], new AbortController().signal); }
    catch (error) { if (!(error instanceof ProviderError)) throw error; diagnostic = runtimeFailure(crypto.randomUUID(), error); }
    // Then diagnostics expose only the fixed category and inference is not repeated.
    expect(diagnostic).toMatchObject({ event_type: 'response.incomplete', incomplete_reason: 'unknown', retryable: false });
    expect(JSON.stringify(diagnostic)).not.toContain(wireReason);
    expect(JSON.stringify(diagnostic)).not.toContain('private.example');
    expect(attempts).toBe(1);
  } finally { provider.close(); await server.stop(true); }
});
