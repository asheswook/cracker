import { afterEach, beforeEach, expect, mock, test } from 'bun:test';
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { Chat } from '../../src/Chat';
import { client } from '../../src/store';
import { Id } from '../../src/types';

let attachmentLoading = false;
mock.module('../../src/attachmentDrafts', () => ({
  useAttachmentDrafts: () => ({ drafts: [], error: '', storageFailed: false, retrying: false,
    retry: () => {}, loading: attachmentLoading, progress: () => undefined }),
  removeDrafts: async () => {}, uploadDraft: async () => {}, addDrafts: async () => {},
}));
const originalSend = client.send;
let root: Root;
let host: HTMLDivElement;
let editor: HTMLTextAreaElement;
let sent: string[];

beforeEach(async () => {
  attachmentLoading = false;
  Object.defineProperty(window, 'webkit', { configurable: true, value: undefined });
  // Given a rendered Chat with a saved draft and no attachment work.
  const workspace = Id.parse(crypto.randomUUID());
  const conversation = Id.parse(crypto.randomUUID());
  sent = [];
  client.send = async content => { sent.push(content); };
  client['value'] = { ...client.snapshot(), workspace, selected: conversation, assistantId: conversation };
  localStorage.setItem(`assistant:draft:${workspace}:${conversation}`, JSON.stringify({ text: '첫 줄', version: 'initial' }));
  host = document.createElement('div'); document.body.append(host);
  await act(async () => {
    root = createRoot(host);
    root.render(<Chat messages={[]} syncedCursor={0} outbox={[]} selected={conversation} error=""
      task={undefined} vm={undefined} connected={false} assistantName="Assistant" />);
  });
  const input = host.querySelector('textarea');
  if (!input) throw new Error('Missing composer textarea');
  editor = input;
});
afterEach(async () => {
  await act(async () => root.unmount());
  host.remove(); client.send = originalSend;
  Object.defineProperty(window, 'webkit', { configurable: true, value: undefined });
});

async function native(platform: 'macos' | 'ios' | 'unavailable') {
  await act(async () => root.unmount());
  Object.defineProperty(window, 'webkit', { configurable: true, value: { messageHandlers: { assistantNative: {
    postMessage: async ({ method }: { readonly method: string }) => {
      if (method !== 'getNotificationState' || platform === 'unavailable') throw new Error('Unsupported fixture method');
      return { version: 1, platform, installation_id: '11111111-1111-4111-8111-111111111111', configured: false, permission: 'default', token: null };
    },
  } } } });
  await act(async () => {
    root = createRoot(host);
    root.render(<Chat messages={[]} syncedCursor={0} outbox={[]} selected={client.snapshot().selected} error=""
      task={undefined} vm={undefined} connected={false} assistantName="Assistant" />);
  });
  const input = host.querySelector('textarea');
  if (!input) throw new Error('Missing native host web composer');
  editor = input;
}

async function enter(modifier: KeyboardEventInit = {}) {
  const event = new window.KeyboardEvent('keydown', { key: 'Enter', bubbles: true, cancelable: true, ...modifier });
  await act(async () => { editor.dispatchEvent(event); });
  return event;
}

for (const modifier of [{}, { shiftKey: true }, { ctrlKey: true }, { metaKey: true }, { altKey: true }, { isComposing: true }]) {
  test(`Return preserves native editing without sending: ${JSON.stringify(modifier)}`, async () => {
    // When Return is delivered to the real Chat textarea handler.
    const event = new window.KeyboardEvent('keydown', { key: 'Enter', bubbles: true, cancelable: true, ...modifier });
    await act(async () => { editor.dispatchEvent(event); });
    // Then the browser remains free to edit and no send reaches the client.
    expect(event.defaultPrevented).toBe(false);
    expect(sent).toEqual([]);
    expect(editor.value).toBe('첫 줄');
  });
}

test('send button sends the exact multiline draft once', async () => {
  // Given a multiline edit in the actual controlled textarea.
  const setValue = Object.getOwnPropertyDescriptor(window.HTMLTextAreaElement.prototype, 'value')?.set;
  if (!setValue) throw new Error('Missing textarea value setter');
  await act(async () => {
    setValue.call(editor, '첫 줄\n둘째 줄');
    editor.dispatchEvent(new window.Event('input', { bubbles: true }));
  });
  const button = host.querySelector<HTMLButtonElement>('button.send-button');
  if (!button) throw new Error('Missing send button');
  // When the visible send button is activated.
  await act(async () => button.click());
  // Then only the explicit action submits, preserving the newline.
  expect(sent).toEqual(['첫 줄\n둘째 줄']);
  expect(editor.value).toBe('');
});

test('confirmed native Mac plain Enter sends through the existing composer once', async () => {
  await native('macos');
  const event = await enter();
  expect(event.defaultPrevented).toBe(true);
  expect(sent).toEqual(['첫 줄']);
  expect(editor.value).toBe('');
});

for (const platform of ['ios', 'unavailable'] as const) test(`${platform} host retains Enter editing`, async () => {
  await native(platform);
  expect((await enter()).defaultPrevented).toBe(false);
  expect(sent).toEqual([]);
});

for (const modifier of [{ shiftKey: true }, { ctrlKey: true }, { metaKey: true }, { altKey: true }, { isComposing: true }, { keyCode: 229 }]) {
  test(`native Mac modifier or IME confirmation never submits: ${JSON.stringify(modifier)}`, async () => {
    await native('macos');
    expect((await enter(modifier)).defaultPrevented).toBe(false);
    expect(sent).toEqual([]);
  });
}

test('native Mac composing interval blocks Enter until composition is finished', async () => {
  await native('macos');
  await act(async () => editor.dispatchEvent(new window.CompositionEvent('compositionstart', { bubbles: true })));
  expect((await enter()).defaultPrevented).toBe(false);
  expect(sent).toEqual([]);
  await act(async () => editor.dispatchEvent(new window.CompositionEvent('compositionend', { bubbles: true })));
  expect((await enter({ keyCode: 229 })).defaultPrevented).toBe(false);
  expect(sent).toEqual([]);
  await enter();
  expect(sent).toEqual(['첫 줄']);
});

test('native Mac key repeat does not submit a draft', async () => {
  await native('macos');
  expect((await enter({ repeat: true })).defaultPrevented).toBe(true);
  expect(sent).toEqual([]);
});

test('native Mac pending attachment loading cannot submit', async () => {
  attachmentLoading = true;
  await native('macos');
  await enter();
  expect(sent).toEqual([]);
});

test('native Mac empty draft cannot submit', async () => {
  await native('macos');
  const setValue = Object.getOwnPropertyDescriptor(window.HTMLTextAreaElement.prototype, 'value')?.set;
  if (!setValue) throw new Error('Missing textarea value setter');
  await act(async () => {
    setValue.call(editor, '');
    editor.dispatchEvent(new window.Event('input', { bubbles: true }));
  });
  await enter();
  expect(sent).toEqual([]);
});

test('native Mac repeated presses during pending send do not duplicate submission', async () => {
  await native('macos');
  const pending = Promise.withResolvers<void>();
  client.send = async content => { sent.push(content); await pending.promise; };
  await enter();
  await enter();
  expect(sent).toEqual(['첫 줄']);
  await act(async () => pending.resolve());
});
