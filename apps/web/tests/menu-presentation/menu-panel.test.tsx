import { afterEach, beforeEach, expect, mock, test } from 'bun:test';
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { App } from '../../src/App';
import { client } from '../../src/store';
import { Id } from '../../src/types';
import { negotiateHybrid } from '../../src/native-hybrid';
import { panelTransition } from '../../src/panel-transition';
import { ReaderSnapshot, type ReaderSnapshotValue } from '../../src/native-reader-protocol';
import { z } from 'zod';

mock.module('../../src/Inspector', () => ({ Inspector: ({ panel }: { panel: string }) => <div data-panel={panel}>{panel}</div> }));
const ReaderCommand = z.object({ kind: z.string(), document: z.uuid(), scope: z.string(), navigation: z.number(), sequence: z.number(), suspended: z.boolean().optional() });
const NativeCommand = z.object({ method: z.string(), version: z.number().optional(), source: z.string().optional(), kind: z.string().optional(), document: z.string().optional(), generation: z.number().optional(), target: z.string().optional(), reader: ReaderSnapshot.optional() });
const originalInit = client.init;
let root: Root | undefined;
let host: HTMLDivElement;
let snapshot: ReaderSnapshotValue | undefined;
let revision = 0;
let oldHost = false;
let resolveCover: ((value: object) => void) | undefined;
let events: string[];
let workspace: Id;
let conversation: Id;
const traces: { scenario: string; events: string[] }[] = [];
const turn = async () => { await new Promise(resolve => setTimeout(resolve, 12)); };
async function settle() { for (let index = 0; index < 5; index++) await act(turn); }
function button(label: string, selector = '') {
  const found = host.querySelector<HTMLButtonElement>(`${selector} button[aria-label="${label}"]`);
  if (!found) throw new Error(`Missing ${label}`);
  return found;
}
async function click(label: string, selector = '') { await act(async () => button(label, selector).click()); await settle(); }
async function mount() {
  await act(async () => { root = createRoot(host); root.render(<App />); });
  await settle();
  expect(document.documentElement.dataset['rootScrollTrial']).toBe('true');
  expect(snapshot?.suspended).toBe(false);
}
async function menu() {
  await click('메뉴 열기');
  if (!oldHost) await cover();
  expect(host.querySelector('dialog.menu-dialog[open]')).not.toBeNull();
  expect(snapshot?.suspended).toBe(true);
}
async function cover() {
  expect(resolveCover).toBeDefined();
  await act(async () => { events.push('covered'); resolveCover?.({ ok: true, stage: 'covered' }); });
  await settle();
}
beforeEach(async () => {
  events = []; snapshot = undefined; revision = 0; oldHost = false; resolveCover = undefined;
  host = document.createElement('div'); document.body.append(host);
  workspace = Id.parse(crypto.randomUUID()); conversation = Id.parse(crypto.randomUUID());
  localStorage.setItem(`assistant:draft:${workspace}:${conversation}`, JSON.stringify({ text: 'retained draft', version: 'v1' }));
  client.init = async () => {};
  client['value'] = { ...client.snapshot(), phase: 'ready', workspace, selected: conversation, assistantId: conversation,
    connected: false, syncedCursor: 0, messages: [], outbox: [], tasks: [], vms: [], conversations: [] };
  Object.defineProperty(window, 'webkit', { configurable: true, value: { messageHandlers: {
    assistantNative: { postMessage: async (value: unknown) => {
      const packet = NativeCommand.parse(value);
      if (packet.method === 'composerConnect') return { version: 1, platform: 'ios', document: packet.document };
      if (packet.method !== 'panelTransition') return null;
      events.push(`panel:${packet.kind}:${packet.target}`);
      if (oldHost && (packet.version === 3 || packet.version === 4)) return { ok: false, error: 'invalid' };
      if (packet.kind === 'begin' && packet.source === 'menu') {
        expect(packet.version).toBe(3);
        expect(snapshot?.suspended).toBe(true);
        expect(Boolean(host.querySelector('dialog.menu-dialog[open]'))).toBe(true);
        expect(Boolean(host.querySelector('.has-inspector'))).toBe(false);
        return new Promise<object>(resolve => { resolveCover = resolve; });
      }
      if (packet.kind === 'begin') { expect(packet.version).toBe(packet.target === 'menu' ? 4 : 2); return { ok: true, stage: packet.target === 'chat' ? 'covered' : 'waiting' }; }
      if (packet.kind === 'source') {
        expect(packet.reader?.suspended).toBe(false);
        expect(packet.reader).toEqual(snapshot);
        expect(host.querySelector('.inspector-visible')).toBeNull();
        expect(host.querySelector('.has-inspector')).toBeNull();
        return new Promise<object>(resolve => { resolveCover = resolve; });
      }
      return { ok: true, stage: 'covered' };
    } },
    assistantReader: { postMessage: async (value: unknown) => {
      const packet = ReaderCommand.parse(value);
      if (packet.kind === 'release') return { ok: true };
      events.push(`reader:${packet.kind}:${packet.suspended ?? snapshot?.suspended}`);
      snapshot = ReaderSnapshot.parse({ v: 1, document: packet.document, scope: packet.scope, navigation: packet.navigation,
        sequence: packet.sequence, revision: ++revision, interaction: 0, geometry: 1, mode: 'reading',
        width: 402, height: 874, contentHeight: 2874, offset: 2000, headerHeight: 100,
        suspended: packet.suspended ?? snapshot?.suspended ?? false, keyboardMoving: false, dragging: false });
      return { ok: true, snapshot };
    } },
    assistantHeader: { postMessage: async () => ({ ok: true }) },
    assistantFooter: { postMessage: async () => ({ ok: true }) },
  } } });
  await negotiateHybrid(async value => ({ document: Reflect.get(value, 'document'), version: 1, platform: 'ios', composer: 1, reader: 1, header: 1, footer: 1 }));
});
afterEach(async () => {
  await act(async () => { panelTransition()?.cancel(); root?.unmount(); });
  host.remove(); root = undefined; client.init = originalInit;
  await Bun.write(new URL('../../../../.omo/evidence/native-menu-entry-release/canonical-app-traces.json', import.meta.url), JSON.stringify(traces, null, 2));
});
for (const [label, panel] of [['설정', 'settings'], ['기억', 'memory']] as const) {
  test(`actual App menu→${panel} holds visible menu until native cover without resuming reader`, async () => {
    await mount(); await menu(); events.length = 0;
    const started = performance.now(); await click(label, '.menu-dialog');
    expect(Boolean(host.querySelector('dialog.menu-dialog[open]'))).toBe(true);
    expect(snapshot?.suspended).toBe(true);
    expect(events).not.toContain('reader:bind:false');
    expect(events).not.toContain('panel:source:panel');
    expect(host.querySelector('.has-inspector')).toBeNull();
    await cover();
    expect(Boolean(host.querySelector('dialog.menu-dialog[open]'))).toBe(false);
    expect(host.querySelector(`[data-panel="${panel}"]`)).not.toBeNull();
    expect(performance.now() - started).toBeLessThan(1000);
    expect(document.documentElement.scrollTop).toBe(2000);
    expect(JSON.parse(localStorage.getItem(`assistant:draft:${workspace}:${conversation}`) ?? '{}').text).toBe('retained draft');
    traces.push({ scenario: `menu-${panel}`, events: [...events] });
  });
}
test('direct header entry retains cover gate', async () => {
  await mount(); await click(`${client.snapshot().persona.name} 페르소나 설정`, '.main-surface');
  expect(events).toContain('panel:source:panel'); await cover();
  expect(host.querySelector('[data-panel="settings"]')).not.toBeNull();
  traces.push({ scenario: 'direct-header', events: [...events] });
});
test('older host keeps menu selection functional', async () => {
  await mount(); oldHost = true; await menu(); await click('기억', '.menu-dialog');
  expect(host.querySelector('dialog.menu-dialog[open]')).toBeNull();
  expect(host.querySelector('[data-panel="memory"]')).not.toBeNull();
  traces.push({ scenario: 'old-host', events: [...events] });
});
test('closing and reopening menu cancels pending cover and stale acknowledgement cannot commit', async () => {
  await mount(); await menu(); await click('설정', '.menu-dialog');
  expect(resolveCover).toBeDefined();
  const staleCover = resolveCover;
  await click('메뉴 닫기', '.menu-dialog');
  await menu();
  await act(async () => { staleCover?.({ ok: true, stage: 'covered' }); });
  await settle();
  expect(host.querySelector('.inspector-visible')).toBeNull();
  expect(host.querySelector('dialog.menu-dialog[open]')).not.toBeNull();
  traces.push({ scenario: 'reopen-cancel', events: [...events] });
});
test('scope cancellation prevents stale panel commit', async () => {
  await mount(); await menu(); await click('기억', '.menu-dialog');
  expect(resolveCover).toBeDefined();
  await act(async () => client['patch']({ selected: Id.parse(crypto.randomUUID()) }));
  await cover(); expect(host.querySelector('.inspector-visible')).toBeNull();
  traces.push({ scenario: 'scope-cancel', events: [...events] });
});

test('chat→menu preserves live reader until source cover and acknowledges presented menu without self-cancel', async () => {
  await mount(); events.length = 0;
  await click('메뉴 열기');
  expect(events).toContain('panel:begin:menu');
  expect(events).toContain('panel:source:menu');
  expect(snapshot?.suspended).toBe(false);
  expect(host.querySelector('dialog.menu-dialog[open]')).toBeNull();
  expect(events).not.toContain('reader:bind:true');
  await cover();
  expect(host.querySelector('dialog.menu-dialog[open][data-native-covered]')).not.toBeNull();
  expect(snapshot?.suspended).toBe(true);
  expect(events.indexOf('covered')).toBeLessThan(events.indexOf('reader:bind:true'));
  expect(events).toContain('panel:finish:menu');
  expect(events).not.toContain('panel:cancel:chat');
  expect(JSON.parse(localStorage.getItem(`assistant:draft:${workspace}:${conversation}`) ?? '{}').text).toBe('retained draft');
  traces.push({ scenario: 'chat-menu-cover-order', events: [...events] });
});
test('older host opens menu with ordinary web motion and no accepted cover', async () => {
  await mount(); oldHost = true; await menu();
  expect(host.querySelector('dialog.menu-dialog[open][data-native-covered]')).toBeNull();
  expect(events).not.toContain('panel:finish:menu');
  traces.push({ scenario: 'chat-menu-old-host', events: [...events] });
});
test('repeat chat→menu retains its accepted cover after Settings closes', async () => {
  await mount(); await menu(); await click('설정', '.menu-dialog'); await cover();
  const panelDialog = host.querySelector<HTMLDialogElement>('dialog.inspector-dialog');
  if (!panelDialog) throw new Error('Missing panel dialog');
  await act(async () => panelDialog.click()); await settle();
  expect(host.querySelector('.inspector-visible')).toBeNull();
  events.length = 0;
  await click('메뉴 열기');
  await cover();
  traces.push({ scenario: 'repeat-menu-after-settings', events: [...events] });
  expect(host.querySelector('dialog.menu-dialog[open][data-native-covered]')).not.toBeNull();
  expect(events).toContain('panel:finish:menu');
  expect(events).not.toContain('panel:cancel:chat');
});
test('scope change during menu entry suppresses delayed menu commit', async () => {
  await mount(); await click('메뉴 열기');
  expect(resolveCover).toBeDefined();
  await act(async () => client['patch']({ selected: Id.parse(crypto.randomUUID()) }));
  await cover();
  expect(host.querySelector('dialog.menu-dialog[open]')).toBeNull();
  traces.push({ scenario: 'chat-menu-scope-cancel', events: [...events] });
});
