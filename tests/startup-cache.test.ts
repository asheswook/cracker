import { afterEach, expect, test } from 'bun:test';
import { readStartupCache, writeStartupCache, clearStartupCache } from '../apps/web/src/startup-cache';
import { Id, Message } from '../apps/web/src/types';
import { defaultAppearance } from '../packages/appearance/schema';

const workspace = Id.parse(crypto.randomUUID()), assistantId = Id.parse(crypto.randomUUID());
const storage = new Map<string, string>(), key = `assistant:startup:v1:${workspace}`;
Object.defineProperty(globalThis, 'localStorage', { configurable: true, value: {
  getItem: (key: string) => storage.get(key) ?? null,
  setItem: (key: string, value: string) => { storage.set(key, value); }, removeItem: (key: string) => { storage.delete(key); },
} });
const content = { workspace, assistantId, persona: { name: 'Saved name', role: '', style: '' }, appearance: defaultAppearance,
  appearanceRevision: null, conversations: [{ id: assistantId, title: 'Assistant', created_at: new Date().toISOString() }], messages: [] as Message[] };
afterEach(() => storage.clear());
test('cache survives a reload but is scoped to authenticated workspace and cleared on logout', () => {
  writeStartupCache(content); expect(readStartupCache(workspace)?.persona.name).toBe('Saved name');
  expect(readStartupCache(Id.parse(crypto.randomUUID()))).toBeNull();
  clearStartupCache(workspace); expect(readStartupCache(workspace)).toBeNull();
});
test('malformed, expired, future and mismatched snapshots cannot populate a session', () => {
  for (const raw of ['{bad', JSON.stringify({ ...content, version: 1, savedAt: Date.now() - 8 * 86400_000 }),
    JSON.stringify({ ...content, version: 1, savedAt: Date.now() + 86400_000 }),
    JSON.stringify({ ...content, version: 1, workspace: crypto.randomUUID(), savedAt: Date.now() })]) {
    storage.set(key, raw); expect(readStartupCache(workspace)).toBeNull();
  }
});
test('only the recent bounded message tail is cached without truncating message content', () => {
  const messages = Array.from({ length: 90 }, (_, sequence) => Message.parse({ id: crypto.randomUUID(), conversation_id: assistantId,
    role: 'assistant', content: 'line '.repeat(1000), sequence, created_at: new Date().toISOString(), client_message_id: null }));
  writeStartupCache({ ...content, messages }); const restored = readStartupCache(workspace);
  expect(restored?.messages).toHaveLength(40); expect(restored?.messages[0]?.sequence).toBe(50);
  expect(restored?.messages.at(-1)?.content).toBe(messages[89]?.content);
});
test('foreign conversation messages and oversized serialized entries are rejected', () => {
  writeStartupCache({ ...content, messages: [Message.parse({ id: crypto.randomUUID(), conversation_id: crypto.randomUUID(), role: 'user',
    content: 'other', sequence: 1, created_at: new Date().toISOString(), client_message_id: null })] });
  expect(readStartupCache(workspace)).toBeNull();
  storage.set(key, ' '.repeat(500_001)); expect(readStartupCache(workspace)).toBeNull();
});
