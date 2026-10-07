import { expect, test } from 'bun:test';
import { RootReaderAdapter } from '../../src/native-reader-adapter';

test('footer-owned fallback retires reader without a second failure notice', () => {
  const errors: string[] = [], active: boolean[] = [];
  const adapter = new RootReaderAdapter({ layout: () => ({ width: 402, height: 600, contentHeight: 600, offset: 0 }),
    capture: () => null, source: () => null, target: () => 0, highlight: () => {} },
  async () => ({ ok: false, error: 'unused' }), { active: value => active.push(value), unread: () => {}, awayFromLatest: () => {}, error: value => errors.push(value) });
  adapter.disable(false);
  expect(active).toEqual([false]);
  expect(errors).toEqual([]);
});

test('independent reader failure silently requests latest fallback', () => {
  const errors: string[] = [];
  let fallbacks = 0;
  const adapter = new RootReaderAdapter({ layout: () => ({ width: 402, height: 600, contentHeight: 600, offset: 0 }),
    capture: () => null, source: () => null, target: () => 0, highlight: () => {} },
  async () => ({ ok: false, error: 'unused' }), { active: () => {}, unread: () => {}, awayFromLatest: () => {}, error: value => errors.push(value), fallback: () => { fallbacks++; } });
  adapter.disable();
  expect(errors).toEqual([]);
  expect(fallbacks).toBe(1);
});
