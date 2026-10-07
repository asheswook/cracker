import { afterEach, expect, mock, test } from 'bun:test';
import { HTTPError } from 'ky';
import { defaultAppearance } from '../packages/appearance/schema';

const workspace = crypto.randomUUID(), conversation = crypto.randomUUID();
let sessionFailure: Error | null = null, resourceFailure = false, sessionReads = 0;
let sessionGate: Promise<void> | undefined;
const storage = new Map<string, string>();
Object.defineProperty(globalThis, 'localStorage', { configurable: true, value: {
  getItem: (key: string) => storage.get(key) ?? null,
  setItem: (key: string, value: string) => storage.set(key, value), removeItem: (key: string) => storage.delete(key),
} });
const api = () => ({
  read: async (path: string, schema: { parse: (value: unknown) => unknown }) => {
    if (path === '/v1/session') { sessionReads++; await sessionGate; if (sessionFailure) throw sessionFailure; }
    else if (resourceFailure) throw new TypeError('Network unavailable');
    const bodies: Record<string, unknown> = {
      '/v1/session': { workspace_id: workspace }, '/v1/conversations': { conversations: [] },
      '/v1/tasks': { tasks: [] }, '/v1/vms': { vms: [] }, '/v1/schedules': { schedules: [] }, '/v1/memory': { memories: [] },
      '/v1/settings': { persona: { name: 'Restored', role: '', style: '' } },
      '/v1/appearance': { appearance: defaultAppearance, revision: crypto.randomUUID() },
    };
    return schema.parse(path.includes('/messages?') ? { messages: [], cursor: 0 } : bodies[path]);
  },
  http: { post: () => ({ json: async () => ({ conversation: { id: conversation, title: 'Assistant', created_at: '2026-10-06T00:00:00Z' } }) }), delete: async () => new Response(null, { status: 204 }) },
  errorMessage: () => 'Network unavailable',
});
mock.module('../apps/web/src/api.ts', api);
if (process.env['RECONNECT_BASELINE']) mock.module('../.local/return-screen-1006/release/source/apps/web/src/api.ts', api);
const { ClientStore }: typeof import('../apps/web/src/store') = await import(process.env['RECONNECT_BASELINE'] ? '../.local/return-screen-1006/release/source/apps/web/src/store.ts' : '../apps/web/src/store');
const stores: InstanceType<typeof ClientStore>[] = [];
const create = () => { const store = new ClientStore(); stores.push(store); return store; };
afterEach(async () => { sessionFailure = null; resourceFailure = false; sessionGate = undefined; for (const store of stores.splice(0)) await store.logout(); storage.clear(); sessionReads = 0; });

test('cold-start network failure retries automatically without requiring login', async () => {
  sessionFailure = new TypeError('Offline'); const store = create(); await store.init();
  expect(store.snapshot().phase).toBe('loading');
  sessionFailure = null;
  await new Promise(resolve => setTimeout(resolve, 1150));
  expect(store.snapshot()).toMatchObject({ phase: 'ready', connected: true, error: '', persona: { name: 'Restored' } });
  expect(sessionReads).toBe(2);
});
test('an expired session shows login and does not retry authentication endlessly', async () => {
  sessionFailure = new HTTPError(new Response(null, { status: 401 }), new Request('https://example.test/v1/session'), {} as never);
  const store = create(); await store.init(); expect(store.snapshot().phase).toBe('login');
  await new Promise(resolve => setTimeout(resolve, 1100)); expect(sessionReads).toBe(1);
});
test('duplicate startup and recovery signals share one authentication request', async () => {
  const gate = Promise.withResolvers<void>(); sessionGate = gate.promise; const store = create();
  const first = store.init(), second = store.init(); expect(sessionReads).toBe(1);
  gate.resolve(); await Promise.all([first, second]); expect(store.snapshot().connected).toBe(true);
});
test('logout invalidates an in-flight session restoration', async () => {
  const gate = Promise.withResolvers<void>(); sessionGate = gate.promise; const store = create();
  const first = store.init(); await store.logout(); gate.resolve(); await first;
  expect(store.snapshot()).toMatchObject({ phase: 'login', workspace: null, connected: false });
});
test('an established conversation recovers without losing selection or retaining connection error', async () => {
  const store = create(); await store.init(); const selected = store.snapshot().selected;
  resourceFailure = true; await store.refresh(); expect(store.snapshot().connected).toBe(false);
  resourceFailure = false; await store.refresh();
  expect(store.snapshot()).toMatchObject({ phase: 'ready', connected: true, selected, error: '' });
});
