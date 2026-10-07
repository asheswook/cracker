import { afterEach, expect, test } from 'bun:test';
import { NativeFeedMotion } from '../src/native-feed-motion';
const priorWindow = Object.getOwnPropertyDescriptor(globalThis, 'window');
afterEach(() => {
  if (priorWindow) Object.defineProperty(globalThis, 'window', priorWindow);
  else Reflect.deleteProperty(globalThis, 'window');
});
function fixture(eligible: boolean) {
  const host = Object.assign(new EventTarget(), { innerWidth: 390, innerHeight: 700 });
  Object.defineProperty(globalThis, 'window', { value: host, configurable: true });
  let queries = 0;
  const feed = { scrollTop: 800, clientHeight: 600, clientWidth: 390, scrollHeight: 2000,
    querySelector: () => { queries++; return null; } };
  const identity = { document: crypto.randomUUID(), session: crypto.randomUUID() };
  const motion = new NativeFeedMotion();
  const disconnect = motion.connect({ feed, identity: () => identity, eligible: () => eligible });
  const detail = { version: 1, ...identity, transition: crypto.randomUUID(), startTime: Date.now(), duration: 350,
    curve: 7, fromHeight: 700, toHeight: 400, width: 390 };
  return { host, feed, detail, disconnect, queries: () => queries };
}
test('reader-middle or touching eligibility does not animate or force bottom', () => {
  const f = fixture(false);
  f.host.dispatchEvent(new CustomEvent('assistant-native-keyboard-transition', { detail: f.detail }));
  expect(f.queries()).toBe(0);
  expect(f.feed.scrollTop).toBe(800);
  f.disconnect();
});
test('foreign document or session does not query or animate content', () => {
  const f = fixture(true);
  for (const detail of [{ ...f.detail, document: crypto.randomUUID() }, { ...f.detail, session: crypto.randomUUID() }])
    f.host.dispatchEvent(new CustomEvent('assistant-native-keyboard-transition', { detail }));
  expect(f.queries()).toBe(0);
  expect(f.feed.scrollTop).toBe(800);
  f.disconnect();
});
test('already resized, expired, width mismatched, or baseline mismatched metadata is ignored', () => {
  const f = fixture(true);
  for (const detail of [
    { ...f.detail, toHeight: 700 }, { ...f.detail, startTime: Date.now() - 1000 },
    { ...f.detail, width: 1000 }, { ...f.detail, fromHeight: 500 },
  ]) f.host.dispatchEvent(new CustomEvent('assistant-native-keyboard-transition', { detail }));
  expect(f.queries()).toBe(0);
  expect(f.feed.scrollTop).toBe(800);
  f.disconnect();
});
