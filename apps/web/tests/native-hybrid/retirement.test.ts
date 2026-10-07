import { expect, test } from 'bun:test';
import { negotiateHybrid } from '../../src/native-hybrid';
import { rootReaderAvailable, retireRootReader, setRootScrollActive, isRootScrollActive } from '../../src/root-scroll-trial';

test('chrome failure permanently retires physical root ownership for later workspace mounts in this document', async () => {
  const oldWindow = Object.getOwnPropertyDescriptor(globalThis, 'window');
  const oldDocument = Object.getOwnPropertyDescriptor(globalThis, 'document');
  const host = Object.assign(new EventTarget(), { webkit: { messageHandlers: { assistantReader: {} } } });
  const dataset: Record<string, string> = {};
  Object.defineProperty(globalThis, 'window', { configurable: true, value: host });
  Object.defineProperty(globalThis, 'document', { configurable: true, value: { documentElement: { dataset } } });
  try {
    await negotiateHybrid(async packet => ({ version: 1, platform: 'ios', document: Reflect.get(packet, 'document'), composer: 1, reader: 1, header: 1, footer: 1 }));
    expect(rootReaderAvailable()).toBe(true);
    setRootScrollActive(true);
    let reason: unknown;
    host.addEventListener('assistant-root-reader-disable', event => { reason = (event as CustomEvent).detail; });
    retireRootReader('header');
    expect(reason).toBe('header');
    expect(rootReaderAvailable()).toBe(false);
    expect(isRootScrollActive()).toBe(false);
    expect(dataset['rootScrollTrial']).toBeUndefined();
    setRootScrollActive(true);
    expect(isRootScrollActive()).toBe(false);
  } finally {
    for (const [key, descriptor] of [['window', oldWindow], ['document', oldDocument]] as const) {
      if (descriptor) Object.defineProperty(globalThis, key, descriptor); else Reflect.deleteProperty(globalThis, key);
    }
  }
});
