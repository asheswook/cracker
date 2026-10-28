import { expect, spyOn, test } from 'bun:test';
import { mkdtemp, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import ky from 'ky';
import type { Response as ModelResponse, ResponseOutputItem } from 'openai/resources/responses/responses';
import type { Provider } from '../packages/provider';
import { DaemonEvent, type Assignment, type Message } from '../packages/protocol';
import { Runtime, type RuntimeTiming } from '../services/daemon/runtime';
import { Journal } from '../services/daemon/journal';
import { TaskArtifacts } from '../services/daemon/artifacts';
import { ToolExecutor } from '../services/daemon/tools';

const OPENING = '자료를 비교해 달라진 항목을 정리하겠습니다.';
const NUDGE = '가격이 다른 두 항목을 찾았고 원문을 확인하고 있습니다.';
const SILENCE_NOTE = "If you have a finding the user has not heard yet, say it in one short sentence. If not, reply with nothing.";
const STALE = '새 입력 이전에 만든 오래된 안내입니다.';
const text = (content: string): ResponseOutputItem => ({ type: 'message', id: crypto.randomUUID(), role: 'assistant', status: 'completed', phase: 'final_answer', content: [{ type: 'output_text', text: content, annotations: [] }] });
const response = (output: ResponseOutputItem[]): ModelResponse => ({ id: crypto.randomUUID(), created_at: 0, output_text: '', error: null, incomplete_details: null, instructions: null, metadata: null, model: 'fixture', object: 'response', output, parallel_tool_calls: false, temperature: null, tool_choice: 'auto', tools: [], top_p: null, status: 'completed' });
const extraResponse = (output: ResponseOutputItem[]): ModelResponse => ({...response(output),usage:{input_tokens:120,output_tokens:8,total_tokens:128,input_tokens_details:{cached_tokens:0,cache_write_tokens:0},output_tokens_details:{reasoning_tokens:0}}});
class FinishedJournal extends Journal {
  readonly done = Promise.withResolvers<void>();
  override finish(run: string) { super.finish(run); this.done.resolve(); }
}

async function scenario(names: string[], options: { lane?: 'foreground' | 'background'; origin?: 'user' | 'schedule'; opening?: 'error' | 'empty' | 'failed-response'; nudge?: 'error' | 'empty' | 'failed-response'; resumed?: 'attempted' | 'delivered'; resumeNudge?: { visibleOffset: number; attemptOffset: number; count: number }; natural?: boolean; naturalRounds?: number[]; roundTimes?: number[]; policy?: 'read_only'; followUp?: boolean; steerExtra?: 'opening'|'nudge'; lateSteering?:boolean; steerAtHeldCall?:boolean; timeoutExtra?:'opening'|'nudge'; expireExtra?:()=>void } = {}) {
  const root = await mkdtemp(join(tmpdir(), 'runtime-start-message-'));
  const task = crypto.randomUUID(), run = crypto.randomUUID(), user = crypto.randomUUID();
  const base = Date.now(); let clock = base;
  const request: Message = { id: user, task_id: task, conversation_id: crypto.randomUUID(), role: 'user', content: '자료를 비교해 주세요', sequence: 1, created_at: new Date(base).toISOString(), client_message_id: null };
  const followUp: Message = { ...request, id: crypto.randomUUID(), sequence: 2, content: '두 번째 자료도 비교해 주세요' };
  const assignment: Assignment = { run_id: run, lane: options.lane ?? 'foreground', task: { id: task, conversation_id: request.conversation_id, objective: request.content, origin: options.origin ?? 'user', lane: options.lane ?? 'foreground', state: 'running', reason: null, created_at: request.created_at, updated_at: request.created_at }, messages: [request], instructions: '', memory: [], ...(options.policy ? { run_policy: options.policy } : {}) };
  const events: DaemonEvent[] = [], order: string[] = [], toolArgs: string[] = [];
  const timings:RuntimeTiming[]=[];
  const extraStarted=Promise.withResolvers<AbortSignal>(),releaseExtra=Promise.withResolvers<void>();
  let extraSteered=false,extraAborted=false,modelSawFollowUp=false;
  let assigned = false, rounds = 0, openings = 0, nudges = 0, steered = false;
  let deliveredProgress=false,postProgressReads=0;
  const server = Bun.serve({ port: 0, async fetch(req) {
    const url = new URL(req.url), path = url.pathname;
    if (path === '/v1/daemon/extensions') return Response.json({ skills: [], servers: [] });
    if (path === '/v1/daemon/poll') { const next = !assigned && !options.resumed ? assignment : null; assigned = true; return Response.json({ assignment: next, commands: [], messages: [] }); }
    if (path.startsWith('/v1/daemon/resume/')) return Response.json({ assignment });
    if (path === '/v1/daemon/composing') return Response.json({ generation: 1 });
    if (path === '/v1/daemon/events') {
      const event = DaemonEvent.parse(await req.json()); events.push(event);
      if (event.kind === 'message') order.push(`message:${event.content}`);
      if(options.steerAtHeldCall&&event.kind==='message'&&event.content===OPENING)deliveredProgress=true;
      return Response.json({ accepted: true });
    }
    if(options.steerAtHeldCall&&deliveredProgress&&++postProgressReads>=2)steered=true;
    return Response.json({ messages: steered && Number(url.searchParams.get('after') ?? 0) < 2 ? [followUp] : [] });
  } });
  class FixtureTools extends ToolExecutor {
    constructor() { super(); this.definitions.push({ type: 'function', name: 'fixture_read', description: 'Read a fixture', strict: true, parameters: { type: 'object', properties: {}, required: [], additionalProperties: false } }); }
    override parallelRead(name: string) { return name === 'fixture_read'; }
    override async run(name: string, args: string) { if(steered&&(options.steerExtra||options.steerAtHeldCall))expect(modelSawFollowUp).toBe(true);order.push(`tool:${name}`); toolArgs.push(args); if(options.followUp&&toolArgs.length===1)steered=true; return { text: 'fixture data' }; }
  }
  const journalPath = join(root, 'journal.sqlite');
  if (options.resumed) {
    const artifacts = await TaskArtifacts.create({ http: ky.create({ prefixUrl: server.url.href }), runId: run, conversationId: request.conversation_id, root });
    const seed = new Journal(journalPath); seed.start(run);
    seed.checkpoint({ version: 1, assignment, input: [{ role: 'user', content: request.content }], cursor: 1, seenCallIds: [], artifacts: artifacts.checkpoint(), inputTokens: 0, appliedUserIds: [user], requestProgress: [{ messageId: user, toolRounds: 1, attempted: options.resumed === 'attempted', delivered: options.resumed === 'delivered', ...(options.resumeNudge ? { lastVisibleAt: base + options.resumeNudge.visibleOffset, lastNudgeAt: base + options.resumeNudge.attemptOffset, nudgeCount: options.resumeNudge.count } : {}) }] });
    seed.close();
  }
  const journal = new FinishedJournal(journalPath);
  const extraControl=async(label:'opening'|'nudge',signal:AbortSignal)=>{
    if(options.timeoutExtra===label){options.expireExtra?.();return new Promise<never>(()=>{});}
    if(options.steerExtra!==label||extraSteered)return false;
    extraSteered=true;extraStarted.resolve(signal);
    if(options.lateSteering){await releaseExtra.promise;return true;}
    let aborted:(()=>void)|undefined;
    try{
      await Promise.race([releaseExtra.promise,new Promise<never>((_,reject)=>{aborted=()=>{extraAborted=true;reject(signal.reason);};if(signal.aborted)aborted();else signal.addEventListener('abort',aborted,{once:true});})]);
      return true;
    }finally{if(aborted)signal.removeEventListener('abort',aborted);}
  };
  const provider: Provider = { async respond(input, tools,signal) {
    if (!tools.length) {
      const isNudge = (input.at(-1) as { content?: unknown })?.content === SILENCE_NOTE;
      if(isNudge){
        nudges++; order.push('generate:nudge');
        const stale=await extraControl('nudge',signal);
        expect(input.filter(item => item.type === 'function_call')).toHaveLength(input.filter(item => item.type === 'function_call_output').length);
        if(options.nudge==='error')throw new Error('fixture nudge failure');
        if(options.nudge==='failed-response')return {...response([text(NUDGE)]),status:'failed',error:{code:'server_error',message:'fixture nudge failure'}};
        return extraResponse(options.nudge==='empty'?[]:[text(stale?STALE:NUDGE)]);
      }
      openings++; order.push('generate:opening');
      const stale=await extraControl('opening',signal);
      expect(input.at(-1)).toEqual({ role: 'system', content: "Before continuing, tell the user in one short sentence what you are about to do (no status words, no 'working on it'). Do not answer yet." });
      expect(input.filter(item => item.type === 'function_call')).toHaveLength(input.filter(item => item.type === 'function_call_output').length);
      if (options.opening === 'error') throw new Error('fixture opening failure');
      if (options.opening === 'failed-response') return { ...response([text(OPENING)]), status: 'failed', error: { code: 'server_error', message: 'fixture failure' } };
      return extraResponse(options.opening === 'empty' ? [] : [text(stale?STALE:OPENING)]);
    }
    if(steered&&!modelSawFollowUp&&input.some(item=>'role' in item&&item.role==='user'&&'content' in item&&item.content===followUp.content)){modelSawFollowUp=true;order.push('model:follow-up');}
    const elapsed = options.roundTimes?.[rounds];
    if(elapsed!==undefined)clock=base+elapsed;
    const name = names[rounds++];
    if (!name) return response([text('비교 결과입니다.')]);
    const call: ResponseOutputItem = { type: 'function_call', call_id: `round-${rounds}`, name, arguments: name === 'shell' ? '{"command":"printf fixture"}' : '{}' };
    return response((options.natural && rounds === 1)||options.naturalRounds?.includes(rounds) ? [{ ...text('자료를 비교하겠습니다.'), phase: 'commentary' } as ResponseOutputItem, call] : [call]);
  } };
  const runtime = new Runtime({ controlUrl: server.url.href, token: 'fixture', journal, provider, tools: new FixtureTools(), artifactRoot: root, now:()=>clock,onTiming:event=>timings.push(event) });
  try {
    if (options.resumed) await runtime.recover(); else await runtime.tick();
    if(options.steerExtra){
      const extraSignal=await extraStarted.promise;steered=true;
      if(!options.lateSteering){await runtime.tick(false);expect(extraSignal.aborted).toBe(true);}
      releaseExtra.resolve();
    }
    await journal.done.promise; await runtime.flush();
    const checkpoint = journal.recoverable(run);
    return { openings, nudges, order, events, toolArgs, checkpoint, user, followUp: followUp.id, base,extraAborted,modelSawFollowUp,timings,callIds:journal.observations.forRun(run).map(item=>item.action_id.split(':').at(-1)) };
  } finally { releaseExtra.resolve();await runtime.stop(); journal.close(); await server.stop(true); await rm(root, { recursive: true, force: true }); }
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

for(const steerExtra of ['opening','nudge'] as const)for(const lateSteering of [false,true])test(`${steerExtra} generation drops stale text and calls on ${lateSteering?'pre-publication input':'input-flight cancellation'}`,async()=>{
  const names=steerExtra==='opening'?['shell','fixture_read']:['shell','fixture_read','fixture_read'];
  const result=await scenario(names,{steerExtra,lateSteering,roundTimes:[0,180_001,180_002]});
  expect(result.events.some(event=>event.kind==='message'&&event.content===STALE)).toBe(false);
  expect(result.modelSawFollowUp).toBe(true);
  expect(result.callIds).not.toContain(steerExtra==='opening'?'round-1':'round-2');
  expect(result.callIds).toContain(steerExtra==='opening'?'round-2':'round-3');
  const read=result.order.indexOf('model:follow-up');
  expect(result.order.indexOf('tool:fixture_read')).toBeGreaterThan(read);
  if(!lateSteering){
    expect(result.extraAborted).toBe(true);
    expect(result.timings.filter(event=>event.kind===(steerExtra==='opening'?'provider_start_message':'provider_mid_message'))).toMatchObject([{outcome:'failed'}]);
  }
});

for(const timeoutExtra of ['opening','nudge'] as const)test(`${timeoutExtra} generation has a hard twenty-second budget even when the provider ignores abort`,async()=>{
  const original=AbortSignal.timeout.bind(AbortSignal),controllers:AbortController[]=[],budgets:number[]=[];
  const timeout=spyOn(AbortSignal,'timeout').mockImplementation(ms=>{
    if(ms!==20_000)return original(ms);
    budgets.push(ms);const controller=new AbortController();controllers.push(controller);return controller.signal;
  });
  try{
    const result=await scenario(['shell','fixture_read'],{timeoutExtra,roundTimes:[0,180_001],expireExtra:()=>controllers.at(-1)!.abort(new DOMException('fixture twenty-second deadline','TimeoutError'))});
    expect(budgets).toEqual(timeoutExtra==='opening'?[20_000]:[20_000,20_000]);
    expect(result.toolArgs).toEqual(['{"command":"printf fixture"}','{}']);
    expect(result.events.some(event=>event.kind==='message'&&event.content===(timeoutExtra==='opening'?OPENING:NUDGE))).toBe(false);
    expect(result.timings.filter(event=>event.kind===(timeoutExtra==='opening'?'provider_start_message':'provider_mid_message'))).toMatchObject([{outcome:'failed',duration_ms:expect.any(Number)}]);
  }finally{timeout.mockRestore();}
});

test('steering at the last held-call boundary also defers read-only calls until fresh inference',async()=>{
  const result=await scenario(['fixture_read','fixture_read','fixture_read'],{steerAtHeldCall:true});
  expect(result.modelSawFollowUp).toBe(true);
  expect(result.callIds).toEqual(['round-1','round-3']);
});

test('extra generations record duration and token usage under distinct timing labels',async()=>{
  const result=await scenario(['shell','fixture_read'],{roundTimes:[0,180_001]});
  const extra=result.timings.filter(event=>event.kind==='provider_start_message'||event.kind==='provider_mid_message');
  expect(extra.map(event=>event.kind)).toEqual(['provider_start_message','provider_mid_message']);
  for(const event of extra){
    expect(event).toMatchObject({outcome:'completed',input_tokens:120,output_tokens:8,output_count:1});
    expect(event.duration_ms).toBeGreaterThanOrEqual(0);
  }
});
