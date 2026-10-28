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
const NUDGE = '가격이 다른 두 항목을 찾았고 원문을 확인하고 있습니다.';
const SILENCE_NOTE = "It has been a few minutes. In one short sentence, tell the user what you have found so far or what you are checking now — a real finding, not 'still working'. Do not answer yet.";
const text = (content: string): ResponseOutputItem => ({ type: 'message', id: crypto.randomUUID(), role: 'assistant', status: 'completed', phase: 'final_answer', content: [{ type: 'output_text', text: content, annotations: [] }] });
const response = (output: ResponseOutputItem[]): ModelResponse => ({ id: crypto.randomUUID(), created_at: 0, output_text: '', error: null, incomplete_details: null, instructions: null, metadata: null, model: 'fixture', object: 'response', output, parallel_tool_calls: false, temperature: null, tool_choice: 'auto', tools: [], top_p: null, status: 'completed' });
class FinishedJournal extends Journal {
  readonly done = Promise.withResolvers<void>();
  override finish(run: string) { super.finish(run); this.done.resolve(); }
}

async function scenario(names: string[], options: { lane?: 'foreground' | 'background'; origin?: 'user' | 'schedule'; opening?: 'error' | 'empty' | 'failed-response'; nudge?: 'error' | 'empty' | 'failed-response'; resumed?: 'attempted' | 'delivered'; resumeNudge?: { visibleOffset: number; attemptOffset: number; count: number }; natural?: boolean; naturalRounds?: number[]; roundTimes?: number[]; policy?: 'read_only'; followUp?: boolean } = {}) {
  const root = await mkdtemp(join(tmpdir(), 'runtime-start-message-'));
  const task = crypto.randomUUID(), run = crypto.randomUUID(), user = crypto.randomUUID();
  const base = Date.now(); let clock = base;
  const request: Message = { id: user, task_id: task, conversation_id: crypto.randomUUID(), role: 'user', content: '자료를 비교해 주세요', sequence: 1, created_at: new Date(base).toISOString(), client_message_id: null };
  const followUp: Message = { ...request, id: crypto.randomUUID(), sequence: 2, content: '두 번째 자료도 비교해 주세요' };
  const assignment: Assignment = { run_id: run, lane: options.lane ?? 'foreground', task: { id: task, conversation_id: request.conversation_id, objective: request.content, origin: options.origin ?? 'user', lane: options.lane ?? 'foreground', state: 'running', reason: null, created_at: request.created_at, updated_at: request.created_at }, messages: [request], instructions: '', memory: [], ...(options.policy ? { run_policy: options.policy } : {}) };
  const events: DaemonEvent[] = [], order: string[] = [], toolArgs: string[] = [];
  let assigned = false, rounds = 0, openings = 0, nudges = 0, steered = false;
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
    seed.checkpoint({ version: 1, assignment, input: [{ role: 'user', content: request.content }], cursor: 1, seenCallIds: [], artifacts: artifacts.checkpoint(), inputTokens: 0, appliedUserIds: [user], requestProgress: [{ messageId: user, toolRounds: 1, attempted: options.resumed === 'attempted', delivered: options.resumed === 'delivered', ...(options.resumeNudge ? { lastVisibleAt: base + options.resumeNudge.visibleOffset, lastNudgeAt: base + options.resumeNudge.attemptOffset, nudgeCount: options.resumeNudge.count } : {}) }] });
    seed.close();
  }
  const journal = new FinishedJournal(journalPath);
  const provider: Provider = { async respond(input, tools) {
    if (!tools.length) {
      const isNudge = (input.at(-1) as { content?: unknown })?.content === SILENCE_NOTE;
      if(isNudge){
        nudges++; order.push('generate:nudge');
        expect(input.filter(item => item.type === 'function_call')).toHaveLength(input.filter(item => item.type === 'function_call_output').length);
        if(options.nudge==='error')throw new Error('fixture nudge failure');
        if(options.nudge==='failed-response')return {...response([text(NUDGE)]),status:'failed',error:{code:'server_error',message:'fixture nudge failure'}};
        return response(options.nudge==='empty'?[]:[text(NUDGE)]);
      }
      openings++; order.push('generate:opening');
      expect(input.at(-1)).toEqual({ role: 'system', content: "Before continuing, tell the user in one short sentence what you are about to do (no status words, no 'working on it'). Do not answer yet." });
      expect(input.filter(item => item.type === 'function_call')).toHaveLength(input.filter(item => item.type === 'function_call_output').length);
      if (options.opening === 'error') throw new Error('fixture opening failure');
      if (options.opening === 'failed-response') return { ...response([text(OPENING)]), status: 'failed', error: { code: 'server_error', message: 'fixture failure' } };
      return response(options.opening === 'empty' ? [] : [text(OPENING)]);
    }
    const elapsed = options.roundTimes?.[rounds];
    if(elapsed!==undefined)clock=base+elapsed;
    const name = names[rounds++];
    if (!name) return response([text('비교 결과입니다.')]);
    const call: ResponseOutputItem = { type: 'function_call', call_id: `round-${rounds}`, name, arguments: name === 'shell' ? '{"command":"printf fixture"}' : '{}' };
    return response((options.natural && rounds === 1)||options.naturalRounds?.includes(rounds) ? [{ ...text('자료를 비교하겠습니다.'), phase: 'commentary' } as ResponseOutputItem, call] : [call]);
  } };
  const runtime = new Runtime({ controlUrl: server.url.href, token: 'fixture', journal, provider, tools: new FixtureTools(), artifactRoot: root, now:()=>clock });
  try {
    if (options.resumed) await runtime.recover(); else await runtime.tick();
    await journal.done.promise; await runtime.flush();
    const checkpoint = journal.recoverable(run);
    return { openings, nudges, order, events, toolArgs, checkpoint, user, followUp: followUp.id, base };
  } finally { await runtime.stop(); journal.close(); await server.stop(true); await rm(root, { recursive: true, force: true }); }
}

test('two silent read rounds deliver one commentary before round two and keep held calls unchanged', async () => {
  const result = await scenario(['fixture_read', 'fixture_read', 'fixture_read']);
  expect(result.order).toEqual(['tool:fixture_read', 'generate:opening', `message:${OPENING}`, 'tool:fixture_read', 'tool:fixture_read', 'message:비교 결과입니다.']);
  expect(result.openings).toBe(1);
  expect(result.toolArgs).toEqual(['{}', '{}', '{}']);
  expect(result.events.filter(event => event.kind === 'message' && event.content === OPENING)).toMatchObject([{ phase: 'commentary', response_to_message_id: result.user }]);
  expect(result.checkpoint?.requestProgress).toMatchObject([{ messageId: result.user, toolRounds: 2, attempted: true, delivered: true, lastVisibleAt: result.base }]);
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

test('silence shorter than three minutes never generates a middle message', async () => {
  const result=await scenario(['shell','fixture_read'],{roundTimes:[0,179_999]});
  expect(result.openings).toBe(1);expect(result.nudges).toBe(0);
  expect(result.order).toEqual(['generate:opening',`message:${OPENING}`,'tool:shell','tool:fixture_read','message:비교 결과입니다.']);
});
test('three minutes of silence generates one middle message before held calls, not again in that interval', async () => {
  const result=await scenario(['shell','fixture_read','fixture_read'],{roundTimes:[0,180_001,180_002]});
  expect(result.nudges).toBe(1);
  expect(result.order).toEqual(['generate:opening',`message:${OPENING}`,'tool:shell','generate:nudge',`message:${NUDGE}`,'tool:fixture_read','tool:fixture_read','message:비교 결과입니다.']);
  expect(result.events.filter(event=>event.kind==='message'&&event.content===NUDGE)).toMatchObject([{phase:'commentary',response_to_message_id:result.user}]);
  expect(result.checkpoint?.requestProgress).toMatchObject([{nudgeCount:1,lastNudgeAt:result.base+180_001}]);
});
test('a second three-minute silence generates a second distinct middle message', async () => {
  const result=await scenario(['shell','fixture_read','fixture_read'],{roundTimes:[0,180_001,360_002]});
  expect(result.nudges).toBe(2);
  const messages=result.events.filter(event=>event.kind==='message'&&event.content===NUDGE);
  expect(messages).toHaveLength(2);expect(new Set(messages.map(event=>event.event_id)).size).toBe(2);
  expect(result.order.filter(item=>item==='generate:nudge'||item===`message:${NUDGE}`||item==='tool:fixture_read')).toEqual(['generate:nudge',`message:${NUDGE}`,'tool:fixture_read','generate:nudge',`message:${NUDGE}`,'tool:fixture_read']);
});
test('middle messages are capped at three attempts per user request', async () => {
  const result=await scenario(['shell',...Array(5).fill('fixture_read')],{roundTimes:[0,180_001,360_002,540_003,720_004,900_005]});
  expect(result.nudges).toBe(3);
  expect(result.toolArgs).toHaveLength(6);
  expect(result.checkpoint?.requestProgress).toMatchObject([{nudgeCount:3,lastNudgeAt:result.base+540_003}]);
});
test('natural commentary resets the silence clock before the next tool round', async () => {
  const result=await scenario(['shell','fixture_read','fixture_read'],{roundTimes:[0,170_000,340_000],naturalRounds:[2]});
  expect(result.nudges).toBe(0);
});
test('an idempotent replay of old commentary does not restart the silence clock',async()=>{
  const result=await scenario(['shell','fixture_read','fixture_read','fixture_read'],{roundTimes:[0,170_000,340_000,360_001],naturalRounds:[2,3,4]});
  expect(result.nudges).toBe(1);
});
test('background and run-policy tasks never receive middle-message nudges', async () => {
  const background=await scenario(['shell','fixture_read'],{lane:'background',natural:true,roundTimes:[0,360_000]});
  expect(background.openings).toBe(0);expect(background.nudges).toBe(0);
  const policy=await scenario(['read_attention','read_attention'],{policy:'read_only',natural:true,roundTimes:[0,360_000]});
  expect(policy.openings).toBe(0);expect(policy.nudges).toBe(0);
});
for(const nudge of ['error','empty','failed-response'] as const)test(`a ${nudge} middle generation does not hold up calls or repeat within three minutes`,async()=>{
  const result=await scenario(['shell','fixture_read','fixture_read'],{nudge,roundTimes:[0,180_001,180_002]});
  expect(result.nudges).toBe(1);expect(result.toolArgs).toHaveLength(3);
  expect(result.events.some(event=>event.kind==='message'&&event.content===NUDGE)).toBe(false);
  expect(result.checkpoint?.requestProgress).toMatchObject([{nudgeCount:1,lastNudgeAt:result.base+180_001}]);
});
test('restart preserves a reserved silence interval without reissuing its nudge',async()=>{
  const result=await scenario(['fixture_read'],{resumed:'delivered',resumeNudge:{visibleOffset:-300_000,attemptOffset:-60_000,count:1}});
  expect(result.nudges).toBe(0);
  expect(result.checkpoint?.requestProgress).toMatchObject([{nudgeCount:1,lastNudgeAt:result.base-60_000}]);
});
test('restart preserves the three-nudge cap even after more silence',async()=>{
  const result=await scenario(['fixture_read'],{resumed:'delivered',resumeNudge:{visibleOffset:-600_000,attemptOffset:-300_000,count:3}});
  expect(result.nudges).toBe(0);
});
