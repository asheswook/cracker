import { afterEach, expect, mock, test } from 'bun:test';
import { Id, Message, ReplyComposing, Task } from '../apps/web/src/types';
import { defaultAppearance } from '../packages/appearance/schema';

const conversation = Id.parse(crypto.randomUUID()), other = Id.parse(crypto.randomUUID());
const task = Task.parse({ id: crypto.randomUUID(), conversation_id: conversation, objective: 'Fixture', state: 'running', reason: null, created_at: new Date().toISOString(), updated_at: new Date().toISOString() });
const message = Message.parse({ id: crypto.randomUUID(), conversation_id: conversation, role: 'user', content: 'Synthetic input', sequence: 1, created_at: new Date().toISOString(), client_message_id: null, read_at: new Date().toISOString() });
const signal = ReplyComposing.parse({ task_id: task.id, run_id: crypto.randomUUID(), inference_id: crypto.randomUUID(), generation: 1, response_id: 'fixture', item_id: 'fixture', input_message_ids: [message.id], expires_at: new Date(Date.now() + 60000).toISOString() });
let page: (path: string) => Promise<unknown>;
let tasks: Task[];
let resources: Promise<void> | null;
let visibility = 'visible';
const calls: { time: number; path: string }[] = [];
mock.module('../apps/web/src/api.ts', () => ({
  read: async (path: string, schema: { parse: (value: unknown) => unknown }) => {
    if (path.includes('/messages?')) { calls.push({ time: performance.now(), path }); return schema.parse(await page(path)); }
    if (path === '/v1/session') return schema.parse({ workspace_id: conversation });
    if (resources) await resources;
    const bodies: Record<string, unknown> = {
      '/v1/conversations': { conversations: [] }, '/v1/tasks': { tasks }, '/v1/vms': { vms: [] },
      '/v1/schedules': { schedules: [] }, '/v1/memory': { memories: [] }, '/v1/settings': { persona: { name: 'Fixture', role: '', style: '' } },
      '/v1/appearance': { appearance: defaultAppearance, revision: conversation },
    };
    return schema.parse(bodies[path]);
  },
  http: {
    post: () => ({ json: async () => ({ conversation: { id: conversation, title: 'Fixture', created_at: new Date().toISOString() } }) }),
    delete: async () => new Response(null, { status: 204 }),
  },
  errorMessage: () => 'Synthetic failure',
}));
const { ClientStore } = await import('../apps/web/src/store');
const stores: InstanceType<typeof ClientStore>[] = [];
const originalStorage = Object.getOwnPropertyDescriptor(globalThis, 'localStorage');
const originalDocument = Object.getOwnPropertyDescriptor(globalThis, 'document');
async function setup() {
  Object.defineProperty(globalThis, 'localStorage', { configurable: true, value: { getItem: () => null, setItem: () => {} } });
  Object.defineProperty(globalThis, 'document', { configurable: true, value: { get visibilityState() { return visibility; } } });
  tasks = [task]; resources = null; visibility = 'visible'; calls.length = 0;
  page = async () => ({ messages: [message], cursor: 1, composing: null });
  const store = new ClientStore(); stores.push(store); await store.init(); return store;
}
async function until(check: () => boolean) {
  const deadline = performance.now() + 1800;
  while (!check() && performance.now() < deadline) await Bun.sleep(10);
  expect(check()).toBe(true);
}
afterEach(async () => {
  resources = null;
  for (const store of stores.splice(0)) await store.logout();
  for (const [key, descriptor] of [['localStorage', originalStorage], ['document', originalDocument]] as const) {
    if (descriptor) Object.defineProperty(globalThis, key, descriptor); else Reflect.deleteProperty(globalThis, key);
  }
});

test('selected composing polling proceeds while resource refresh is stalled and never overlaps message requests', async () => {
  const store = await setup(), blocked = Promise.withResolvers<void>(), response = Promise.withResolvers<unknown>();
  resources = blocked.promise;
  const refresh = store.refresh();
  page = async () => response.promise;
  await until(() => calls.length === 2);
  await Bun.sleep(650);
  expect(calls).toHaveLength(2);
  response.resolve({ messages: [], cursor: 1, composing: signal });
  await until(() => store.snapshot().composing !== null);
  page = async () => ({ messages: [], cursor: 1, composing: null });
  await until(() => store.snapshot().composing === null);
  blocked.resolve(); await refresh;
  expect(store.snapshot().composing).toBeNull();
  console.log(JSON.stringify({ scenario: 'nonoverlap-independent-resource-refresh', calls }));
});

test('hidden or inactive conversations do not use fast polling; selected task does not fabricate typing', async () => {
  const store = await setup();
  expect(store.snapshot().composing).toBeNull();
  visibility = 'hidden'; await Bun.sleep(650); expect(calls).toHaveLength(1);
  visibility = 'visible'; await until(() => calls.length === 2);
  tasks = [{ ...task, state: 'cancelled' }]; await store.refresh();
  const count = calls.length; await Bun.sleep(650); expect(calls).toHaveLength(count);
  expect(store.snapshot().composing).toBeNull();
  console.log(JSON.stringify({ scenario: 'visibility-task-gating', calls }));
});

test('late composing cannot reappear after A to B to A selection or logout', async () => {
  const store = await setup(), response = Promise.withResolvers<unknown>();
  page = async path => path.includes(other) ? { messages: [], cursor: 0, composing: null } : response.promise;
  await until(() => calls.length === 2);
  await store.select(other);
  const returning = store.select(conversation);
  response.resolve({ messages: [], cursor: 1, composing: signal }); await returning;
  expect(store.snapshot().composing).toBeNull();
  const late = Promise.withResolvers<unknown>(); page = async () => late.promise;
  const selecting = store.select(conversation); await store.logout();
  late.resolve({ messages: [message], cursor: 1, composing: signal }); await selecting;
  expect(store.snapshot().phase).toBe('login'); expect(store.snapshot().composing).toBeNull(); expect(store.snapshot().messages).toHaveLength(0);
  console.log(JSON.stringify({ scenario: 'selection-and-session-epoch', calls }));
});

test('a lease entirely between polls remains unobserved instead of inventing composing', async () => {
  const store = await setup();
  let active = false;
  const transitions: { time: number; active: boolean }[] = [];
  page = async () => ({ messages: [], cursor: 1, composing: active ? signal : null });
  await Bun.sleep(80); active = true; transitions.push({ time: performance.now(), active });
  await Bun.sleep(150); active = false; transitions.push({ time: performance.now(), active });
  await until(() => calls.length === 2);
  expect(store.snapshot().composing).toBeNull();
  active = true;
  await until(() => store.snapshot().composing !== null);
  console.log(JSON.stringify({ scenario: 'short-lease-polling-limit', transitions, calls }));
});
