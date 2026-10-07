import { afterEach, expect, mock, test } from 'bun:test';
import { AppearanceSettings, defaultAppearance } from '../packages/appearance/schema';
import { Id } from '../apps/web/src/types';

const workspace = Id.parse(crypto.randomUUID());
const saved = AppearanceSettings.parse({ appearance: { ...defaultAppearance, color: 'blue' }, revision: crypto.randomUUID() });
const newer = AppearanceSettings.parse({ appearance: { ...defaultAppearance, color: 'pink' }, revision: crypto.randomUUID() });
let appearanceRead: () => Promise<unknown>;
mock.module('../apps/web/src/api.ts', () => ({
  read: async (path: string, schema: { parse: (value: unknown) => unknown }) => {
    if (path === '/v1/appearance') return schema.parse(await appearanceRead());
    const bodies: Record<string, unknown> = {
      '/v1/session': { workspace_id: workspace }, '/v1/conversations': { conversations: [] },
      '/v1/tasks': { tasks: [] }, '/v1/vms': { vms: [] }, '/v1/schedules': { schedules: [] },
      '/v1/memory': { memories: [] }, '/v1/settings': { persona: { name: 'Fixture', role: '', style: '' } },
    };
    return schema.parse(path.includes('/messages?') ? { messages: [], cursor: 0 } : bodies[path]);
  },
  http: {
    get: () => ({ json: async () => appearanceRead() }),
    post: () => ({ json: async () => ({ conversation: { id: workspace, title: 'Fixture', created_at: new Date().toISOString() } }) }),
    delete: async () => new Response(null, { status: 204 }),
  },
  errorMessage: () => 'Synthetic failure',
}));
const { ClientStore } = await import('../apps/web/src/store');
const stores: InstanceType<typeof ClientStore>[] = [];
const originalStorage = Object.getOwnPropertyDescriptor(globalThis, 'localStorage');
async function setup() {
  Object.defineProperty(globalThis, 'localStorage', { configurable: true, value: { getItem: () => null, setItem: () => {} } });
  appearanceRead = async () => saved;
  const store = new ClientStore(); stores.push(store); await store.init(); return store;
}
afterEach(async () => {
  for (const store of stores.splice(0)) await store.logout();
  if (originalStorage) Object.defineProperty(globalThis, 'localStorage', originalStorage);
  else Reflect.deleteProperty(globalThis, 'localStorage');
});

test('appearance initializes from server data and keeps its revision', async () => {
  // Given / When
  const store = await setup();
  // Then
  expect(store.snapshot().appearance).toEqual(saved.appearance);
  expect(store.snapshot().appearanceRevision).toBe(saved.revision);
});

test('unchanged appearance does not invalidate the snapshot during ordinary refresh', async () => {
  // Given
  const store = await setup(), previous = store.snapshot();
  // When
  await store.refresh();
  // Then
  expect(store.snapshot()).toBe(previous);
});

test('explicit appearance refresh updates independent state without changing persona', async () => {
  // Given
  const store = await setup(), persona = store.snapshot().persona;
  appearanceRead = async () => newer;
  // When
  const result = await store.refreshAppearance();
  // Then
  expect(result).toEqual(newer);
  expect(store.snapshot().appearance).toEqual(newer.appearance);
  expect(store.snapshot().appearanceRevision).toBe(newer.revision);
  expect(store.snapshot().persona).toBe(persona);
});

test('a slower ordinary refresh cannot overwrite a newer explicit appearance refresh', async () => {
  // Given
  const store = await setup(), delayed = Promise.withResolvers<unknown>();
  appearanceRead = () => delayed.promise;
  const refreshing = store.refresh();
  appearanceRead = async () => newer;
  await store.refreshAppearance();
  // When
  delayed.resolve(saved); await refreshing;
  // Then
  expect(store.snapshot().appearance).toEqual(newer.appearance);
  expect(store.snapshot().appearanceRevision).toBe(newer.revision);
});

test('a slower explicit appearance read cannot overwrite a later explicit read', async () => {
  // Given
  const store = await setup(), delayed = Promise.withResolvers<unknown>();
  appearanceRead = () => delayed.promise;
  const refreshing = store.refreshAppearance();
  appearanceRead = async () => newer;
  await store.refreshAppearance();
  // When
  delayed.resolve(saved); const result = await refreshing;
  // Then
  expect(result).toBeUndefined();
  expect(store.snapshot().appearanceRevision).toBe(newer.revision);
});

test('logout resets appearance and rejects a late workspace response', async () => {
  // Given
  const store = await setup(), delayed = Promise.withResolvers<unknown>();
  appearanceRead = () => delayed.promise;
  const refreshing = store.refreshAppearance();
  await store.logout();
  // When
  delayed.resolve(newer); const result = await refreshing;
  // Then
  expect(result).toBeUndefined();
  expect(store.snapshot().appearance).toEqual(defaultAppearance);
  expect(store.snapshot().appearanceRevision).toBeNull();
  expect(store.snapshot().phase).toBe('login');
});

test('failed explicit appearance reads preserve the last confirmed server value', async () => {
  // Given
  const store = await setup(); appearanceRead = async () => { throw new TypeError('Synthetic read failure'); };
  // When / Then
  await expect(store.refreshAppearance()).rejects.toThrow('Synthetic read failure');
  expect(store.snapshot().appearance).toEqual(saved.appearance);
  expect(store.snapshot().appearanceRevision).toBe(saved.revision);
});


test('an aborted explicit read cannot publish or return a panel value', async () => {
  // Given
  const store = await setup(), delayed = Promise.withResolvers<unknown>(), controller = new AbortController();
  appearanceRead = () => delayed.promise;
  const refreshing = store.refreshAppearance(controller.signal);
  // When
  controller.abort(); delayed.resolve(newer);
  // Then
  expect(await refreshing).toBeUndefined();
  expect(store.snapshot().appearanceRevision).toBe(saved.revision);
});
