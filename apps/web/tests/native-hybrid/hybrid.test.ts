import { expect, test } from 'bun:test';
import { hybridEnabled, negotiateHybrid } from '../../src/native-hybrid';

test('web and old native retain web fallback; no partial feature activation', async () => {
  expect(await negotiateHybrid()).toBe(false);
  expect(await negotiateHybrid(async () => { throw new Error('Unknown native bridge method'); })).toBe(false);
  expect(hybridEnabled()).toBe(false);
});
test('only an exact document-bound complete iOS v1 capability reply activates', async () => {
  const reply = (packet: object) => ({ ...packet, platform: 'ios', composer: 1, reader: 1, header: 1, footer: 1 });
  expect(await negotiateHybrid(async packet => { const { method, ...value } = packet as { method: string; document: string; version: number }; return reply(value); })).toBe(true);
  expect(hybridEnabled()).toBe(true);
  expect(await negotiateHybrid(async () => ({ version: 1, document: crypto.randomUUID(), platform: 'ios', composer: 1, reader: 1, header: 1, footer: 1 }))).toBe(false);
  expect(hybridEnabled()).toBe(false);
  expect(await negotiateHybrid(async packet => ({ ...reply(packet), footer: 2 }))).toBe(false);
});
