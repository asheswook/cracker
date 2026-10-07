import { afterEach, expect, mock, test } from 'bun:test';
import { Id, Message, MessagePage, ReplyComposing, ReplyHandoff, Vm } from '../apps/web/src/types';
import { defaultAppearance } from '../packages/appearance/schema';
import { conversation, message, other, task } from './client-working-fixture';

const signal = ReplyComposing.parse({ task_id: task.id, run_id: crypto.randomUUID(), inference_id: crypto.randomUUID(), generation: 1, response_id: 'response', item_id: 'item', input_message_ids: [message.id], expires_at: new Date(Date.now() + 60000).toISOString() });
const delivery = () => ReplyHandoff.parse({ ...signal, status: 'delivering', delivery_event_id: crypto.randomUUID(), expires_at: new Date(Date.now() + 5000).toISOString() });
const reply = Message.parse({ ...message, id: crypto.randomUUID(), task_id: task.id, role: 'assistant', sequence: 2, content: 'Actual reply' });
let page: (path: string) => Promise<unknown>;
let resourceError: Error | null = null;
let sendResult: Promise<unknown> = Promise.resolve();
let tasks = [task];
let vms: Vm[] = [];
const calls: string[] = [];
mock.module('../apps/web/src/api.ts', () => ({
  read: async (path: string, schema: { parse: (value: unknown) => unknown }) => {
    if (path.includes('/messages?')) { calls.push(path); return schema.parse(await page(path)); }
    if (path === '/v1/session') return schema.parse({ workspace_id: conversation });
    if (resourceError) throw resourceError;
    const bodies: Record<string, unknown> = {
      '/v1/conversations': { conversations: [] }, '/v1/tasks': { tasks }, '/v1/vms': { vms },
      '/v1/schedules': { schedules: [] }, '/v1/memory': { memories: [] }, '/v1/settings': { persona: { name: 'Fixture', role: '', style: '' } },
      '/v1/appearance': { appearance: defaultAppearance, revision: conversation },
    };
    return schema.parse(bodies[path]);
  },
  http: {
    post: (path: string) => path === '/v1/assistant/conversation'
      ? { json: async () => ({ conversation: { id: conversation, title: 'Fixture', created_at: message.created_at } }) }
      : sendResult,
    delete: async () => new Response(null, { status: 204 }),
  },
  errorMessage: () => 'Synthetic failure',
}));
const { ClientStore } = await import('../apps/web/src/store');
const { controlTransport, ControlFailure } = await import('../apps/web/src/controlReceipt');
const originalSubmit = controlTransport.submit;
const stores: InstanceType<typeof ClientStore>[] = [];
const originalStorage = Object.getOwnPropertyDescriptor(globalThis, 'localStorage');
async function setup() {
  Object.defineProperty(globalThis, 'localStorage', { configurable: true, value: { getItem: () => null, setItem: () => {} } });
  resourceError = null; sendResult = Promise.resolve(); tasks = [task]; vms = []; calls.length = 0;
  page = async () => ({ messages: [message], cursor: 1, composing: signal, reply_handoff: null });
  const store = new ClientStore(); stores.push(store); await store.init(); return store;
}
afterEach(async () => {
  controlTransport.submit = originalSubmit;
  for (const store of stores.splice(0)) await store.logout();
  if (originalStorage) Object.defineProperty(globalThis, 'localStorage', originalStorage);
  else Reflect.deleteProperty(globalThis, 'localStorage');
});

test('rolling compatibility distinguishes omitted metadata from an explicit null outcome', () => {
  expect(MessagePage.parse({ messages: [], cursor: 0 }).reply_handoff).toBeUndefined();
  expect(MessagePage.parse({ messages: [], cursor: 0, reply_handoff: null }).reply_handoff).toBeNull();
});

test('message, composing end and handoff are one observable snapshot', async () => {
  const store = await setup(), handoff = delivery(), observed: ReturnType<typeof store.snapshot>[] = [];
  const stop = store.subscribe(() => observed.push(store.snapshot()));
  page = async () => ({ messages: [], cursor: 1, composing: null, reply_handoff: handoff });
  await store.refresh();
  expect(observed).toHaveLength(1); expect(observed[0]?.composing).toBeNull(); expect(observed[0]?.replyHandoff).toEqual(handoff);
  observed.length = 0;
  page = async () => ({ messages: [reply], cursor: 2, composing: null, reply_handoff: null });
  await store.refresh();
  expect(observed).toHaveLength(1); expect(observed[0]?.messages.at(-1)?.id).toBe(reply.id); expect(observed[0]?.replyHandoff).toBeNull();
  stop();
});

test('handoff expires while the next poll is stalled and an expired response cannot revive it', async () => {
  const store = await setup(), handoff = { ...delivery(), expires_at: new Date(Date.now() + 120).toISOString() };
  page = async () => ({ messages: [], cursor: 1, composing: null, reply_handoff: handoff }); await store.refresh();
  const response = Promise.withResolvers<unknown>(); page = () => response.promise;
  const pending = store.refresh(); await Bun.sleep(170);
  expect(store.snapshot().replyHandoff).toBeNull();
  response.resolve({ messages: [], cursor: 1, composing: null, reply_handoff: handoff }); await pending;
  expect(store.snapshot().replyHandoff).toBeNull();
});

test('old handoff cannot erase valid newer composing', async () => {
  const store = await setup(), newer = ReplyComposing.parse({ ...signal, generation: 2, inference_id: crypto.randomUUID() });
  page = async () => ({ messages: [], cursor: 1, composing: newer, reply_handoff: delivery() }); await store.refresh();
  expect(store.snapshot().composing).toEqual(newer);
});

test('lease metadata preserves identity on unchanged polls and explicit null clears it', async () => {
  const store = await setup(), handoff = delivery();
  page = async () => ({ messages: [], cursor: 1, composing: null, reply_handoff: handoff }); await store.refresh();
  const before = store.snapshot(); await store.refresh(); expect(store.snapshot()).toBe(before);
  page = async () => ({ messages: [], cursor: 1, composing: null, reply_handoff: null }); await store.refresh();
  expect(store.snapshot().replyHandoff).toBeNull();
});

test('late handoff cannot revive after A to B to A selection or logout', async () => {
  const store = await setup(), response = Promise.withResolvers<unknown>();
  page = path => path.includes(other) ? Promise.resolve({ messages: [], cursor: 0, reply_handoff: null }) : response.promise;
  const first = store.select(conversation); await store.select(other); const returning = store.select(conversation);
  response.resolve({ messages: [], cursor: 1, reply_handoff: delivery() }); await Promise.all([first, returning]);
  expect(store.snapshot().replyHandoff).toBeNull();
  const late = Promise.withResolvers<unknown>(); page = () => late.promise;
  const selecting = store.select(conversation); await store.logout(); late.resolve({ messages: [], cursor: 1, reply_handoff: delivery() }); await selecting;
  expect(store.snapshot().phase).toBe('login'); expect(store.snapshot().replyHandoff).toBeUndefined();
});

test('disconnect clears handoff and an in-flight page cannot restore it', async () => {
  const store = await setup(), response = Promise.withResolvers<unknown>();
  page = async () => ({ messages: [], cursor: 1, reply_handoff: delivery() }); await store.refresh();
  page = () => response.promise; const selecting = store.select(conversation);
  resourceError = new TypeError('Synthetic transport failure'); await store.refresh();
  response.resolve({ messages: [], cursor: 1, reply_handoff: delivery() }); await selecting;
  expect(store.snapshot().connected).toBe(false); expect(store.snapshot().replyHandoff).toBeNull();
});

test('new local input clears handoff before a delayed send finishes', async () => {
  const store = await setup(), sent = Promise.withResolvers<void>();
  page = async () => ({ messages: [], cursor: 1, reply_handoff: delivery() }); await store.refresh();
  sendResult = sent.promise; const sending = store.send('new input');
  expect(store.snapshot().replyHandoff).toBeNull(); expect(store.snapshot().outbox).toHaveLength(1);
  page = async () => ({ messages: [], cursor: 1, reply_handoff: null }); sent.resolve(); await sending;
});

test('message polling failure clears a previously valid handoff', async () => {
  const store = await setup();
  page = async () => ({ messages: [], cursor: 1, reply_handoff: delivery() }); await store.refresh();
  page = async () => { throw new TypeError('Synthetic message transport failure'); }; await store.refresh();
  expect(store.snapshot().connected).toBe(false); expect(store.snapshot().replyHandoff).toBeNull();
});

test('terminal task keeps fast polling only while explicit delivery is pending', async () => {
  const store = await setup(); tasks = [{ ...task, state: 'succeeded' }];
  page = async () => ({ messages: [], cursor: 1, reply_handoff: delivery() }); await store.refresh();
  const before = calls.length; await Bun.sleep(580); expect(calls.length).toBeGreaterThan(before);
  page = async () => ({ messages: [], cursor: 1, reply_handoff: null }); await store.refresh();
  const stopped = calls.length; await Bun.sleep(580); expect(calls).toHaveLength(stopped);
});

test('takeover suppresses old and pending polls; a failed request permits a fresh genuine signal', async () => {
  const store = await setup(), submitted = Promise.withResolvers<Id>(), old = Promise.withResolvers<unknown>();
  const vm = Id.parse(crypto.randomUUID());
  controlTransport.submit = () => submitted.promise;
  page = () => old.promise; const polling = store.refresh();
  await Bun.sleep(0);
  const takeover = store.control(vm, 'takeover');
  expect(store.snapshot().composing).toBeNull(); expect(store.snapshot().replyHandoff).toBeNull();
  old.resolve({ messages: [], cursor: 1, composing: signal, reply_handoff: delivery() }); await polling;
  expect(store.snapshot().composing).toBeNull(); expect(store.snapshot().replyHandoff).toBeNull();
  page = async () => ({ messages: [], cursor: 1, composing: signal, reply_handoff: delivery() }); await store.refresh();
  expect(store.snapshot().composing).toBeNull(); expect(store.snapshot().replyHandoff).toBeNull();
  submitted.reject(new ControlFailure('Synthetic takeover rejected')); await takeover;
  expect(store.snapshot().control[vm]?.phase).toBe('failed');
  await store.refresh(); expect(store.snapshot().composing).toEqual(signal);
});

test('confirmed user control suppresses stale metadata until agent ownership is reconciled', async () => {
  const store = await setup();
  const vm = Vm.parse({ id: crypto.randomUUID(), name: 'Fixture', last_seen_at: new Date().toISOString(), control_state: 'user' });
  vms = [vm]; page = async () => ({ messages: [], cursor: 1, composing: signal, reply_handoff: delivery() });
  await store.refresh(); expect(store.snapshot().composing).toBeNull(); expect(store.snapshot().replyHandoff).toBeNull();
  vms = [{ ...vm, control_state: 'agent' }]; await store.refresh(); expect(store.snapshot().composing).toEqual(signal);
});
