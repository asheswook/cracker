import { afterEach, expect, test } from 'bun:test';
import { connectComposer } from '../src/native-composer-transport';
import { NativeComposerController } from '../src/native-composer';
import type { NativeComposerMessage } from '../src/native-bridge';

const priorWindow = Object.getOwnPropertyDescriptor(globalThis, 'window');
afterEach(() => {
  if (priorWindow) Object.defineProperty(globalThis, 'window', priorWindow);
  else Reflect.deleteProperty(globalThis, 'window');
});
function fixture(reply: (message: NativeComposerMessage) => unknown) {
  Object.defineProperty(globalThis, 'window', { configurable: true, value: {
    webkit: { messageHandlers: { assistantNative: { postMessage: async (message: NativeComposerMessage) => reply(message) } } },
  } });
  const controller = new NativeComposerController(() => {});
  controller.bind({ scope: 'scope', read: () => ({ text: 'preserve me', version: 'revision', error: '' }),
    write: text => ({ text, version: 'revision', error: '' }), send: async () => true, attach: () => {},
    state: () => ({ visible: true, editable: true, sendEnabled: true, attachEnabled: true, placeholder: 'Message', error: '',
      theme: { canvas: '#ffffff', surface: '#ffffff', ink: '#000000', muted: '#888888', accent: '#fa7002' } }),
  });
  return controller;
}
test('iOS v1 activates only after first state accepted', async () => {
  const calls: string[] = [];
  const controller = fixture(message => {
    calls.push(message.method);
    return message.method === 'composerConnect' ? { version: 1, platform: 'ios', document: message.document } : null;
  });
  expect(await connectComposer(controller)).toBe(true);
  expect(calls).toEqual(['composerConnect', 'composerState']);
});
test('macOS and unsupported version preserve fallback without publishing state', async () => {
  for (const identity of [{ platform: 'macos', version: 1 }, { platform: 'ios', version: 2 }]) {
    const calls: string[] = [];
    const controller = fixture(message => {
      calls.push(message.method);
      return message.method === 'composerConnect' ? { ...identity, document: message.document } : null;
    });
    expect(await connectComposer(controller)).toBe(false);
    expect(calls).toEqual(['composerConnect']);
  }
});
test('old app unknown method rejects negotiation without losing canonical draft', async () => {
  const controller = fixture(() => { throw new Error('Unknown method'); });
  await expect(connectComposer(controller)).rejects.toThrow('Unknown method');
  expect(controller.snapshot()?.text).toBe('preserve me');
});
test('first state rejection preserves fallback even after successful connect', async () => {
  const controller = fixture(message => message.method === 'composerConnect'
    ? { version: 1, platform: 'ios', document: message.document } : { error: 'unsupported state' });
  await expect(connectComposer(controller)).rejects.toThrow('rejected state');
  expect(controller.snapshot()?.text).toBe('preserve me');
});
test('browser without native bridge remains unsupported', async () => {
  const controller = fixture(() => null);
  Object.defineProperty(globalThis, 'window', { configurable: true, value: {} });
  await expect(connectComposer(controller)).rejects.toThrow('unavailable');
});

test('unmounted document does not publish after delayed negotiation', async () => {
  const calls: string[] = [];
  const controller = fixture(message => {
    calls.push(message.method);
    return message.method === 'composerConnect' ? { version: 1, platform: 'ios', document: message.document } : null;
  });
  expect(await connectComposer(controller, () => false)).toBe(false);
  expect(calls).toEqual(['composerConnect']);
});
