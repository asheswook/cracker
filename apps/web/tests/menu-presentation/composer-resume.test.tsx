import { afterEach, beforeEach, expect, test } from 'bun:test';
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { z } from 'zod';
import { useNativeComposer } from '../../src/native-composer-hook';
import type { ComposerBinding, ComposerDraft } from '../../src/native-composer';
import { negotiateHybrid } from '../../src/native-hybrid';
const Packet = z.object({ method: z.string(), document: z.string().optional(), state: z.object({ document: z.string(), session: z.string(), text: z.string(), ack: z.number(), focus: z.number().optional(), sendEnabled: z.boolean() }).optional() });
type Packet = z.infer<typeof Packet>;
let root: Root | undefined, host: HTMLDivElement, draft: ComposerDraft, scope: string;
let api: ReturnType<typeof useNativeComposer> | undefined;
let packets: Packet[], pauseState: boolean, paused: boolean, rejectState: boolean, oldHost: boolean;
let pending: { resolve: (value: unknown) => void; reject: (reason: Error) => void }[];
let writes: number, sends: number;
const binding: ComposerBinding = {
  get scope() { return scope; }, read: () => draft,
  write: text => { writes++; return draft = { text, version: 'edited', error: '' }; },
  state: () => ({ visible: true, editable: true, sendEnabled: true, attachEnabled: true, placeholder: '', error: '',
    theme: { canvas: '#ffffff', surface: '#ffffff', ink: '#000000', muted: '#888888', accent: '#fa7002' } }),
  send: async () => { sends++; return true; }, attach: () => {},
};
function Probe() { api = useNativeComposer('workspace', binding); return <output>{api.active ? 'native' : 'web'}</output>; }
const turn = async () => { for (let i = 0; i < 30; i++) await Promise.resolve(); };
async function render() { await act(async () => { root?.render(<Probe />); await turn(); }); }
async function visibility(value: 'hidden' | 'visible') { await act(async () => {
  Object.defineProperty(document, 'visibilityState', { configurable: true, value });
  document.dispatchEvent(new Event('visibilitychange')); await turn();
}); }
function state() { const found = [...packets].reverse().find(packet => packet.state)?.state; if (!found) throw new Error('Missing state'); return found; }
async function mount() { root = createRoot(host); await render(); }
beforeEach(async () => {
  Object.defineProperty(document, 'visibilityState', { configurable: true, value: 'visible' });
  Object.assign(globalThis, { MutationObserver: window.MutationObserver });
  host = document.createElement('div'); document.body.append(host);
  draft = { text: 'incoming resume draft', version: 'original', error: '' }; scope = 'workspace:conversation';
  packets = []; pending = []; pauseState = false; paused = false; rejectState = false; oldHost = false; writes = 0; sends = 0;
  document.documentElement.scrollTop = 1234;
  Object.defineProperty(window, 'webkit', { configurable: true, value: { messageHandlers: { assistantNative: { postMessage: async (input: unknown) => {
    const packet = Packet.parse(input); packets.push(packet);
    if (paused || (pauseState && packet.method === 'composerState')) return new Promise<unknown>((resolve, reject) => pending.push({ resolve, reject }));
    if (packet.method === 'composerConnect') return oldHost ? null : { version: 1, platform: 'ios', document: packet.document };
    return rejectState && packet.method === 'composerState' ? { error: 'rejected' } : null;
  } } } } });
  await negotiateHybrid(async value => ({ document: Reflect.get(value, 'document'), version: 1, platform: 'ios', composer: 1, reader: 1, header: 1, footer: 1 }));
});
afterEach(async () => { await act(async () => { paused = false; for (const request of pending) request.resolve(null); await turn(); root?.unmount(); }); host.remove(); root = undefined; });
test('hidden incoming rerenders coalesce without transport or fallback; latest state resumes', async () => {
  // Given an acknowledged native composer with a canonical draft and reading position.
  await mount(); expect(host.textContent).toBe('native'); const identity = api?.identity();
  await visibility('hidden'); const before = packets.length;
  // When incoming traffic rerenders while the native transport cannot reply.
  paused = true; await render(); await render(); await render();
  // Then no background request starts, and only the latest snapshot is sent on return.
  expect(packets.length).toBe(before); expect(host.textContent).toBe('native');
  paused = false; await visibility('visible');
  expect(packets.length).toBe(before + 1); expect(state().text).toBe(draft.text);
  expect(api?.identity()).toEqual(identity); expect(writes).toBe(0); expect(sends).toBe(0);
  expect(document.documentElement.scrollTop).toBe(1234);
});
test('late old failure cannot retire successful same-document foreground reconnect', async () => {
  await mount(); const identity = api?.identity(); paused = true; await render(); expect(pending.length).toBeGreaterThan(0);
  await visibility('hidden'); paused = false; await visibility('visible');
  expect(host.textContent).toBe('native'); expect(api?.identity()).toEqual(identity);
  await act(async () => { for (const request of pending) request.reject(new Error('late old timeout')); await turn(); });
  expect(host.textContent).toBe('native'); expect(packets.filter(p => p.method === 'composerHide')).toHaveLength(0);
  expect(packets.filter(p => p.method === 'composerConnect')).toHaveLength(2);
});
test('mount already hidden defers handshake until visible', async () => {
  await visibility('hidden'); await mount(); expect(packets).toHaveLength(0); expect(host.textContent).toBe('web');
  await visibility('visible'); expect(host.textContent).toBe('native');
});
test('idle healthy foreground does not renegotiate or publish', async () => {
  await mount(); const before = packets.length; await visibility('hidden'); await visibility('visible'); expect(packets.length).toBe(before);
});
test('genuine foreground rejection remains fallback across later visibility changes', async () => {
  await mount(); rejectState = true; await render(); expect(host.textContent).toBe('web');
  const count = packets.length; await visibility('hidden'); await visibility('visible'); expect(packets.length).toBe(count);
});
test('unsupported composer handshake keeps usable fallback without retry loop', async () => {
  oldHost = true; await mount(); expect(host.textContent).toBe('web');
  await visibility('hidden'); await visibility('visible'); expect(packets.filter(p => p.method === 'composerConnect')).toHaveLength(1);
});
test('hidden IME edit retains ack, draft and composition without deferred focus', async () => {
  await mount(); const before = state(); await visibility('hidden'); const count = packets.length;
  await act(async () => { await window.__assistantComposer?.({ version: 1, kind: 'edit', document: before.document, session: before.session, scope,
    seq: 1, text: '가', composing: true, selection: { start: 1, end: 1 } }); api?.focus(); await turn(); });
  expect(packets.length).toBe(count); await visibility('visible');
  expect(state().text).toBe('가'); expect(state().ack).toBe(1); expect(state().sendEnabled).toBe(false); expect(state().focus).toBe(before.focus);
  expect(writes).toBe(1); expect(sends).toBe(0);
});
test('late prior-session failure cannot hide new scope', async () => {
  await mount(); paused = true; await render(); paused = false; scope = 'workspace:other'; await render();
  await act(async () => { for (const request of pending) request.reject(new Error('old scope')); await turn(); });
  expect(host.textContent).toBe('native'); expect(packets.filter(p => p.method === 'composerHide')).toHaveLength(0);
});
test('real 3-second in-flight timeout during hidden interval recovers without hide', async () => {
  await mount(); paused = true; await render(); await visibility('hidden');
  await act(async () => { await new Promise(resolve => setTimeout(resolve, 3100)); });
  expect(host.textContent).toBe('native'); expect(packets.filter(p => p.method === 'composerHide')).toHaveLength(0);
  paused = false; await visibility('visible'); expect(host.textContent).toBe('native');
  expect(packets.filter(p => p.method === 'composerConnect')).toHaveLength(2); expect(state().text).toBe(draft.text);
});
test('late handshake ACK from old lifecycle cannot post state after successful reconnect', async () => {
  paused = true; await mount(); const oldConnect = packets[0]; await visibility('hidden'); paused = false; await visibility('visible');
  expect(host.textContent).toBe('native'); const count = packets.length;
  await act(async () => { for (const request of pending) request.resolve({ version: 1, platform: 'ios', document: oldConnect?.document }); await turn(); });
  expect(packets.length).toBe(count); expect(host.textContent).toBe('native');
});
test('foreground reconnect state rejection falls back instead of blindly activating', async () => {
  await mount(); paused = true; await render(); await visibility('hidden'); paused = false; rejectState = true;
  await visibility('visible'); expect(host.textContent).toBe('web'); expect(packets.filter(p => p.method === 'composerHide')).toHaveLength(1);
});
test('late handshake after unmount cannot post or reattach native callbacks', async () => {
  paused = true; await mount(); const connect = packets[0];
  await act(async () => root?.unmount()); root = undefined; const count = packets.length;
  await act(async () => { for (const request of pending) request.resolve({ version: 1, platform: 'ios', document: connect?.document }); await turn(); });
  expect(packets.length).toBe(count); expect(window.__assistantComposer).toBeUndefined();
});
test('initial state rejection for superseded scope reconnects current session', async () => {
  pauseState = true; await mount(); expect(host.textContent).toBe('web'); const old = state();
  scope = 'workspace:new'; await render(); pauseState = false;
  await act(async () => { for (const request of pending) request.reject(new Error('old session rejected')); await turn(); });
  expect(host.textContent).toBe('native'); expect(state().session).not.toBe(old.session);
  expect(packets.filter(p => p.method === 'composerHide')).toHaveLength(0);
});
