import { afterEach, expect, test } from 'bun:test';
import { nativeNotificationState } from '../apps/web/src/native-bridge';

const originalWindow = Object.getOwnPropertyDescriptor(globalThis, 'window');
const originalTimer = globalThis.setTimeout;
const state = {
  version: 1, platform: 'ios', installation_id: '11111111-1111-4111-8111-111111111111',
  configured: true, permission: 'granted', token: 'fixture-fcm-token',
} as const;
afterEach(() => {
  if (originalWindow) Object.defineProperty(globalThis, 'window', originalWindow);
  else Reflect.deleteProperty(globalThis, 'window');
});

for (const delay of [31_000, 44_000]) {
  test(`notification opt-in accepts a valid native reply at ${delay}ms`, async () => {
    let reply: (value: unknown) => void = () => { throw new Error('Bridge was not called'); };
    const native = new Promise<unknown>((resolve) => { reply = resolve; });
    Object.defineProperty(globalThis, 'window', { configurable: true, value: {
      webkit: { messageHandlers: { assistantNative: { postMessage: () => native } } },
    } });
    let deadline = 0;
    let expire = () => {};
    Reflect.set(globalThis, 'setTimeout', (callback: () => void, milliseconds?: number) => {
      deadline = milliseconds ?? 0;
      expire = () => callback();
      return originalTimer(() => {}, 100_000);
    });
    try {
      const result = nativeNotificationState(true).then(
        (value) => ({ kind: 'success', value }),
        (error: unknown) => ({ kind: 'failure', error }),
      );
      if (deadline <= delay) expire();
      reply(state);
      expect(await result).toEqual({ kind: 'success', value: state });
    } finally { Reflect.set(globalThis, 'setTimeout', originalTimer); }
  });
}

test('an unresponsive native request still rejects at its bounded deadline', async () => {
  Object.defineProperty(globalThis, 'window', { configurable: true, value: {
    webkit: { messageHandlers: { assistantNative: { postMessage: () => new Promise(() => {}) } } },
  } });
  let expire = () => {};
  let deadline = 0;
  Reflect.set(globalThis, 'setTimeout', (callback: () => void, milliseconds?: number) => {
    deadline = milliseconds ?? 0;
    expire = () => callback();
    return originalTimer(() => {}, 100_000);
  });
  try {
    const result = nativeNotificationState(true).catch((error: unknown) => error);
    expire();
    expect(await result).toMatchObject({ code: 'timeout' });
    expect(deadline).toBeLessThanOrEqual(60_000);
  } finally { Reflect.set(globalThis, 'setTimeout', originalTimer); }
});
