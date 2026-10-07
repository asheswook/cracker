import { afterEach, expect, mock, test } from 'bun:test';
import ky from 'ky';
import { defaultAppearance } from '../packages/appearance/schema';
import { conversation, message, other, task, working as fixtureWorking } from './client-working-fixture';

const working = { ...fixtureWorking, expires_at: new Date(Date.now() + 60_000).toISOString() };

let page: (path: string) => Promise<unknown>;
let resourceError: Error | null = null;
let sendResult: Promise<unknown> = Promise.resolve();
const initialPage = () => ({ messages: [message], cursor: 1, working });
mock.module('../apps/web/src/api.ts', () => ({
  read: async (path: string, schema: { parse: (value: unknown) => unknown }) => {
    if (path.includes('/messages?')) return schema.parse(await page(path));
    if (path === '/v1/session') return schema.parse({ workspace_id: conversation });
    if (path.startsWith('/v1/sources/')) return schema.parse({ message: { ...message, conversation_id: other }, conversation_id: other });
    if (resourceError) throw resourceError;
    const bodies: Record<string, unknown> = {
      '/v1/conversations': { conversations: [] }, '/v1/tasks': { tasks: [task] }, '/v1/vms': { vms: [] },
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
const stores: InstanceType<typeof ClientStore>[] = [];
const originalStorage = Object.getOwnPropertyDescriptor(globalThis, 'localStorage');
async function setup() {
  Object.defineProperty(globalThis, 'localStorage', { configurable: true, value: { getItem: () => null, setItem: () => {} } });
  resourceError = null; sendResult = Promise.resolve(); page = async () => initialPage();
  const store = new ClientStore(); stores.push(store); await store.init(); return store;
}
afterEach(async () => {
  for (const store of stores.splice(0)) await store.logout();
  if (originalStorage) Object.defineProperty(globalThis, 'localStorage', originalStorage);
  else Reflect.deleteProperty(globalThis, 'localStorage');
});

test('working snapshot preserves object identity and emits nothing for unchanged synchronization', async () => {
  // Given
  const store = await setup(), previous = store.snapshot(), calls: number[] = [];
  const unsubscribe = store.subscribe(() => calls.push(1));
  // When
  await store.refresh();
  // Then
  expect(store.snapshot()).toBe(previous);
  expect(store.snapshot().working).toEqual(working);
  expect(calls).toHaveLength(0);
  unsubscribe();
});

for (const response of [{ messages: [], cursor: 1 }, { messages: [], cursor: 1, working: null }]) {
  test(`working clears when the next page signal is ${'working' in response ? 'null' : 'omitted'}`, async () => {
    // Given
    const store = await setup(); page = async () => response;
    // When
    await store.refresh();
    // Then
    expect(store.snapshot().working).toBeNull();
  });
}

test('working clears immediately for a local send before a delayed response', async () => {
  // Given
  const store = await setup(), sent = Promise.withResolvers<void>(); sendResult = sent.promise;
  page = async () => ({ messages: [], cursor: 1, working: null });
  // When
  const sending = store.send('new input');
  // Then
  expect(store.snapshot().working).toBeNull();
  expect(store.snapshot().outbox).toHaveLength(1);
  sent.resolve(); await sending;
});

test('late working cannot revive after A to B to A selection', async () => {
  // Given
  const store = await setup(), response = Promise.withResolvers<unknown>();
  page = async path => path.includes(other) ? { messages: [], cursor: 0, working: null } : response.promise;
  const first = store.select(conversation);
  await store.select(other);
  const returning = store.select(conversation);
  // When
  response.resolve(initialPage()); await Promise.all([first, returning]);
  // Then
  expect(store.snapshot().selected).toBe(conversation);
  expect(store.snapshot().working).toBeNull();
});

test('late working cannot revive after logout or hydrate a cleared session', async () => {
  // Given
  const store = await setup(), response = Promise.withResolvers<unknown>();
  page = async () => response.promise;
  const selecting = store.select(conversation); await store.logout();
  // When
  response.resolve(initialPage()); await selecting;
  // Then
  expect(store.snapshot().phase).toBe('login');
  expect(store.snapshot().working).toBeNull();
  expect(store.snapshot().messages).toHaveLength(0);
});

test('working clears on disconnect and a late page cannot restore it while disconnected', async () => {
  // Given
  const store = await setup(), response = Promise.withResolvers<unknown>();
  page = async () => response.promise;
  const selecting = store.select(conversation);
  resourceError = new TypeError('Synthetic resource transport failure');
  await store.refresh();
  // When
  response.resolve(initialPage()); await selecting;
  // Then
  expect(store.snapshot().connected).toBe(false);
  expect(store.snapshot().working).toBeNull();
});

test('working clears after a message transport failure', async () => {
  // Given
  const store = await setup(); page = async () => { throw new TypeError('Synthetic message transport failure'); };
  // When
  await store.refresh();
  // Then
  expect(store.snapshot().connected).toBe(false);
  expect(store.snapshot().working).toBeNull();
});

test('working clears on an actual HTTP authentication failure', async () => {
  // Given
  const store = await setup();
  const server = Bun.serve({ port: 0, fetch: () => new Response(null, { status: 401 }) });
  page = () => ky.get(server.url).json();
  try {
    // When
    await store.refresh();
    // Then
    expect(store.snapshot().phase).toBe('login');
    expect(store.snapshot().working).toBeNull();
    expect(store.snapshot().messages).toHaveLength(0);
  } finally { await server.stop(true); }
});

test('source-only archive hydration clears canonical working state', async () => {
  // Given
  const store = await setup();
  // When
  await store.select(other, message.id);
  // Then
  expect(store.snapshot().selected).toBe(other);
  expect(store.snapshot().messages[0]?.conversation_id).toBe(other);
  expect(store.snapshot().working).toBeNull();
});
