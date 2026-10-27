import { expect, test } from 'bun:test';
import { mkdtemp, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import ky from 'ky';
import type { Response as ModelResponse, ResponseOutputItem } from 'openai/resources/responses/responses';
import type { Provider } from '../packages/provider';
import { DaemonEvent, type Assignment, type Message } from '../packages/protocol';
import { Runtime } from '../services/daemon/runtime';
import { Journal } from '../services/daemon/journal';
import { TaskArtifacts } from '../services/daemon/artifacts';
import { ToolExecutor } from '../services/daemon/tools';

const OPENING = '자료를 비교해 달라진 항목을 정리하겠습니다.';
const text = (content: string): ResponseOutputItem => ({ type: 'message', id: crypto.randomUUID(), role: 'assistant', status: 'completed', phase: 'final_answer', content: [{ type: 'output_text', text: content, annotations: [] }] });
const response = (output: ResponseOutputItem[]): ModelResponse => ({ id: crypto.randomUUID(), created_at: 0, output_text: '', error: null, incomplete_details: null, instructions: null, metadata: null, model: 'fixture', object: 'response', output, parallel_tool_calls: false, temperature: null, tool_choice: 'auto', tools: [], top_p: null, status: 'completed' });
class FinishedJournal extends Journal {
  readonly done = Promise.withResolvers<void>();
  override finish(run: string) { super.finish(run); this.done.resolve(); }
}

async function scenario(names: string[], options: { lane?: 'foreground' | 'background'; origin?: 'user' | 'schedule'; opening?: 'error' | 'empty' | 'failed-response'; resumed?: 'attempted' | 'delivered'; natural?: boolean; policy?: 'read_only'; followUp?: boolean } = {}) {
  const root = await mkdtemp(join(tmpdir(), 'runtime-start-message-'));
  const task = crypto.randomUUID(), run = crypto.randomUUID(), user = crypto.randomUUID();
  const request: Message = { id: user, task_id: task, conversation_id: crypto.randomUUID(), role: 'user', content: '자료를 비교해 주세요', sequence: 1, created_at: new Date().toISOString(), client_message_id: null };
  const followUp: Message = { ...request, id: crypto.randomUUID(), sequence: 2, content: '두 번째 자료도 비교해 주세요' };
  const assignment: Assignment = { run_id: run, lane: options.lane ?? 'foreground', task: { id: task, conversation_id: request.conversation_id, objective: request.content, origin: options.origin ?? 'user', lane: options.lane ?? 'foreground', state: 'running', reason: null, created_at: request.created_at, updated_at: request.created_at }, messages: [request], instructions: '', memory: [], ...(options.policy ? { run_policy: options.policy } : {}) };
  const events: DaemonEvent[] = [], order: string[] = [], toolArgs: string[] = [];
  let assigned = false, rounds = 0, openings = 0, steered = false;
  const server = Bun.serve({ port: 0, async fetch(req) {
    const url = new URL(req.url), path = url.pathname;
    if (path === '/v1/daemon/extensions') return Response.json({ skills: [], servers: [] });
    if (path === '/v1/daemon/poll') { const next = !assigned && !options.resumed ? assignment : null; assigned = true; return Response.json({ assignment: next, commands: [], messages: [] }); }
    if (path.startsWith('/v1/daemon/resume/')) return Response.json({ assignment });
    if (path === '/v1/daemon/composing') return Response.json({ generation: 1 });
    if (path === '/v1/daemon/events') {
      const event = DaemonEvent.parse(await req.json()); events.push(event);
      if (event.kind === 'message') order.push(`message:${event.content}`);
      return Response.json({ accepted: true });
    }
    return Response.json({ messages: steered && Number(url.searchParams.get('after') ?? 0) < 2 ? [followUp] : [] });
  } });
  class FixtureTools extends ToolExecutor {
    constructor() { super(); this.definitions.push({ type: 'function', name: 'fixture_read', description: 'Read a fixture', strict: true, parameters: { type: 'object', properties: {}, required: [], additionalProperties: false } }); }
    override parallelRead(name: string) { return name === 'fixture_read'; }
    override async run(name: string, args: string) { order.push(`tool:${name}`); toolArgs.push(args); if(options.followUp&&toolArgs.length===1)steered=true; return { text: 'fixture data' }; }
  }
  const journalPath = join(root, 'journal.sqlite');
  if (options.resumed) {
    const artifacts = await TaskArtifacts.create({ http: ky.create({ prefixUrl: server.url.href }), runId: run, conversationId: request.conversation_id, root });
    const seed = new Journal(journalPath); seed.start(run);
    seed.checkpoint({ version: 1, assignment, input: [{ role: 'user', content: request.content }], cursor: 1, seenCallIds: [], artifacts: artifacts.checkpoint(), inputTokens: 0, appliedUserIds: [user], requestProgress: [{ messageId: user, toolRounds: 1, attempted: options.resumed === 'attempted', delivered: options.resumed === 'delivered' }] });
    seed.close();
  }
  const journal = new FinishedJournal(journalPath);
  const provider: Provider = { async respond(input, tools) {
    if (!tools.length) {
      openings++; order.push('generate:opening');
      expect(input.at(-1)).toEqual({ role: 'system', content: "Before continuing, tell the user in one short sentence what you are about to do (no status words, no 'working on it'). Do not answer yet." });
      expect(input.filter(item => item.type === 'function_call')).toHaveLength(input.filter(item => item.type === 'function_call_output').length);
      if (options.opening === 'error') throw new Error('fixture opening failure');
      if (options.opening === 'failed-response') return { ...response([text(OPENING)]), status: 'failed', error: { code: 'server_error', message: 'fixture failure' } };
      return response(options.opening === 'empty' ? [] : [text(OPENING)]);
    }
    const name = names[rounds++];
    if (!name) return response([text('비교 결과입니다.')]);
    const call: ResponseOutputItem = { type: 'function_call', call_id: `round-${rounds}`, name, arguments: name === 'shell' ? '{"command":"printf fixture"}' : '{}' };
    return response(options.natural && rounds === 1 ? [{ ...text('자료를 비교하겠습니다.'), phase: 'commentary' } as ResponseOutputItem, call] : [call]);
  } };
  const runtime = new Runtime({ controlUrl: server.url.href, token: 'fixture', journal, provider, tools: new FixtureTools(), artifactRoot: root });
  try {
    if (options.resumed) await runtime.recover(); else await runtime.tick();
    await journal.done.promise; await runtime.flush();
    const checkpoint = journal.recoverable(run);
    return { openings, order, events, toolArgs, checkpoint, user, followUp: followUp.id };
  } finally { await runtime.stop(); journal.close(); await server.stop(true); await rm(root, { recursive: true, force: true }); }
}

test('two silent read rounds deliver one commentary before round two and keep held calls unchanged', async () => {
  const result = await scenario(['fixture_read', 'fixture_read', 'fixture_read']);
  expect(result.order).toEqual(['tool:fixture_read', 'generate:opening', `message:${OPENING}`, 'tool:fixture_read', 'tool:fixture_read', 'message:비교 결과입니다.']);
  expect(result.openings).toBe(1);
  expect(result.toolArgs).toEqual(['{}', '{}', '{}']);
  expect(result.events.filter(event => event.kind === 'message' && event.content === OPENING)).toMatchObject([{ phase: 'commentary', response_to_message_id: result.user }]);
  expect(result.checkpoint?.requestProgress).toEqual([{ messageId: result.user, toolRounds: 2, attempted: true, delivered: true }]);
});
test('a single read round answers without a synthetic opening', async () => {
  const result = await scenario(['fixture_read']);
  expect(result.openings).toBe(0);
  expect(result.order).toEqual(['tool:fixture_read', 'message:비교 결과입니다.']);
});
test('the first write round is held until its opening message is delivered', async () => {
  const result = await scenario(['shell']);
  expect(result.order).toEqual(['generate:opening', `message:${OPENING}`, 'tool:shell', 'message:비교 결과입니다.']);
  expect(result.toolArgs).toEqual(['{"command":"printf fixture"}']);
});
test('background work never invokes the start-message gate', async () => {
  const result = await scenario(['shell', 'fixture_read'], { lane: 'background' });
  expect(result.openings).toBe(0);
  expect(result.order).toEqual(['tool:shell', 'tool:fixture_read', 'message:비교 결과입니다.']);
});
test('non-user task origins and run policies never invoke the start-message gate', async () => {
  expect((await scenario(['shell', 'fixture_read'], { origin: 'schedule' })).openings).toBe(0);
  expect((await scenario(['read_attention', 'read_attention'], { policy: 'read_only' })).openings).toBe(0);
});
test('new user input gets its own durable start-message marker within the same task', async () => {
  const result = await scenario(['shell', 'shell'], { followUp: true });
  expect(result.openings).toBe(2);
  expect(result.events.filter(event=>event.kind==='message'&&event.content===OPENING).map(event=>event.kind==='message'?event.response_to_message_id:null)).toEqual([result.user,result.followUp]);
  expect(result.checkpoint?.requestProgress?.map(state=>state.messageId)).toEqual([result.user,result.followUp]);
});
test('natural visible commentary suppresses the gate', async () => {
  const result = await scenario(['shell', 'fixture_read'], { natural: true });
  expect(result.openings).toBe(0);
  expect(result.order[0]).toBe('message:자료를 비교하겠습니다.');
});
for (const opening of ['error', 'empty', 'failed-response'] as const) test(`an ${opening} extra generation proceeds without retrying the gate`, async () => {
  const result = await scenario(['shell', 'fixture_read'], { opening });
  expect(result.openings).toBe(1);
  expect(result.order).toEqual(['generate:opening', 'tool:shell', 'tool:fixture_read', 'message:비교 결과입니다.']);
});
for (const resumed of ['attempted', 'delivered'] as const) test(`a reopened checkpoint preserves the per-request ${resumed} marker`, async () => {
  const result = await scenario(['fixture_read', 'shell'], { resumed });
  expect(result.openings).toBe(0);
  expect(result.toolArgs).toEqual(['{}', '{"command":"printf fixture"}']);
});
