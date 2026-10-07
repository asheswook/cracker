import { describe, expect, test } from 'bun:test';
import { NativeComposerController, type ComposerBinding, type ComposerDraft, type NativeComposerState } from '../src/native-composer';

function fixture() {
  let draft: ComposerDraft = { text: '', version: '', error: '' };
  let sends = 0, attachments = 0;
  let visible = true;
  const sent: ComposerDraft[] = [];
  const published: NativeComposerState[] = [];
  const controller = new NativeComposerController(state => published.push(state));
  const binding: ComposerBinding = {
    scope: 'workspace:conversation', read: () => draft,
    write: text => draft = { text, version: crypto.randomUUID(), error: '' },
    state: () => ({ visible, editable: true, sendEnabled: Boolean(draft.text.trim()), attachEnabled: true,
      placeholder: 'Message', error: '', theme: { canvas: '#ffffff', surface: '#ffffff', ink: '#000000', muted: '#888888', accent: '#fa7002' } }),
    send: async snapshot => { sends++; sent.push(snapshot); return true; }, attach: () => { attachments++; },
  };
  const state = controller.bind(binding);
  if (!state) throw new Error('Missing initial state');
  const base = { version: 1, document: state.document, session: state.session, scope: state.scope };
  const edit = (seq: number, text: string, composing = false) => ({ ...base, kind: 'edit', seq, text, composing, selection: { start: text.length, end: text.length } });
  const send = (seq: number, text: string) => ({ ...edit(seq, text), kind: 'send', commandId: crypto.randomUUID() });
  return { controller, binding, base, edit, send, sent, published, read: () => draft, sends: () => sends,
    attachments: () => attachments, hide: () => { visible = false; } };
}
describe('native composer ordering and canonical draft/outbox ownership', () => {
  test('immediate send persists and uses its exact snapshot without React render', async () => {
    const f = fixture();
    expect((await f.controller.handle(f.send(1, 'last keystroke🙂'))).accepted).toBe(true);
    expect(f.sent[0]).toEqual(f.read());
    expect(f.sent[0]?.text).toBe('last keystroke🙂');
  });
  test('same command ID and same-tick competing ID create only one send', async () => {
    const f = fixture();
    let finish: (ok: boolean) => void = () => {};
    let calls = 0;
    f.controller.bind({ ...f.binding, send: () => { calls++; return new Promise(resolve => { finish = resolve; }); } });
    const command = f.send(1, 'one');
    const first = f.controller.handle(command);
    expect(f.controller.handle(command)).toBe(first);
    expect((await f.controller.handle({ ...command, commandId: crypto.randomUUID() })).accepted).toBe(false);
    finish(true);
    await first;
    expect(calls).toBe(1);
  });
  test('edits during pending send survive revision-based clearing', async () => {
    const f = fixture();
    let finish: () => void = () => {};
    f.controller.bind({ ...f.binding, send: async snapshot => {
      await new Promise<void>(resolve => { finish = resolve; });
      if (snapshot.version === f.read().version) f.binding.write('');
      return true;
    } });
    const pending = f.controller.handle(f.send(1, 'submitted'));
    await f.controller.handle(f.edit(2, 'later typing'));
    finish();
    await pending;
    expect(f.read().text).toBe('later typing');
  });
  test('marked Korean text persists but cannot submit until a new committed sequence', async () => {
    const f = fixture();
    await f.controller.handle(f.edit(1, '가', true));
    expect((await f.controller.handle({ ...f.send(1, '가'), composing: true })).error).toBe('composing');
    expect((await f.controller.handle(f.send(1, '가'))).error).toBe('stale_edit');
    expect((await f.controller.handle(f.send(2, '가'))).accepted).toBe(true);
    expect(f.sends()).toBe(1);
  });
  test('older and same-sequence different text cannot replace a draft', async () => {
    const f = fixture();
    await f.controller.handle(f.edit(2, 'new'));
    expect((await f.controller.handle(f.edit(1, 'old'))).error).toBe('stale_edit');
    expect((await f.controller.handle(f.send(2, 'other'))).error).toBe('stale_edit');
    expect(f.read().text).toBe('new');
    expect(f.sends()).toBe(0);
  });
  test('late old-session edit saves old scope; old-session send and attach reject', async () => {
    const f = fixture();
    let other = '';
    f.controller.bind({ ...f.binding, scope: 'workspace:other', read: () => ({ text: other, version: 'v', error: '' }),
      write: text => { other = text; return { text, version: 'v', error: '' }; } });
    expect((await f.controller.handle(f.edit(1, 'old scope final'))).accepted).toBe(true);
    expect(f.read().text).toBe('old scope final');
    expect(other).toBe('');
    expect((await f.controller.handle(f.send(2, 'late send'))).error).toBe('inactive_scope');
    expect((await f.controller.handle({ ...f.base, kind: 'attach', commandId: crypto.randomUUID() })).accepted).toBe(false);
  });
  test('hidden composer saves edits but rejects send and picker', async () => {
    const f = fixture(); f.hide();
    expect((await f.controller.handle(f.edit(1, 'saved while hidden'))).accepted).toBe(true);
    expect((await f.controller.handle(f.send(1, 'saved while hidden'))).error).toBe('unavailable');
    expect((await f.controller.handle({ ...f.base, kind: 'attach', commandId: crypto.randomUUID() })).accepted).toBe(false);
  });
  test('attachment dispatch is synchronous and deduplicated', () => {
    const f = fixture();
    const command = { ...f.base, kind: 'attach', commandId: crypto.randomUUID() };
    expect(f.controller.handle(command)).not.toBeInstanceOf(Promise);
    f.controller.handle(command);
    expect(f.attachments()).toBe(1);
  });
  test('UTF-16 selection bounds and 100000 text limit preserve draft without send', async () => {
    const f = fixture();
    expect((await f.controller.handle({ ...f.edit(1, '🙂'), selection: { start: 0, end: 3 } })).error).toBe('invalid_selection');
    expect((await f.controller.handle(f.send(1, 'a'.repeat(100001)))).error).toBe('text_limit');
    expect(f.read().text.length).toBe(100001);
    expect(f.controller.snapshot()?.sendEnabled).toBe(false);
    expect((await f.controller.handle(f.send(2, 'a'.repeat(100000)))).accepted).toBe(true);
  });
  test('changed canonical draft cannot be sent by an old sequence echo', async () => {
    const f = fixture(); await f.controller.handle(f.edit(1, 'native'));
    f.binding.write('external draft');
    expect((await f.controller.handle(f.send(1, 'native'))).error).toBe('stale_draft');
    expect(f.read().text).toBe('external draft');
  });
  test('foreign document and evicted sessions reject', async () => {
    const f = fixture();
    expect((await f.controller.handle({ ...f.edit(1, 'foreign'), document: crypto.randomUUID() })).error).toBe('invalid_command');
    for (let i = 0; i < 9; i++) f.controller.bind({ ...f.binding, scope: `scope-${i}` });
    expect((await f.controller.handle(f.edit(1, 'expired'))).error).toBe('expired_session');
  });
  test('failed send command remains deduplicated and reports failure', async () => {
    const f = fixture(); let calls = 0;
    f.controller.bind({ ...f.binding, send: async () => { calls++; return false; } });
    const command = f.send(1, 'retry requires deliberate decision');
    expect((await f.controller.handle(command)).error).toBe('send_failed');
    expect((await f.controller.handle(command)).error).toBe('send_failed');
    expect(calls).toBe(1);
  });
  test('published generations monotonically increase independently of draft version', async () => {
    const f = fixture(); await f.controller.handle(f.edit(1, 'draft'));
    await f.controller.handle(f.edit(1, 'draft'));
    expect(f.published[1]?.generation).toBeGreaterThan(f.published[0]?.generation ?? 0);
    expect(f.published[1]?.revision).toBe(f.published[0]?.revision ?? '');
  });
});

test('same-text selection/composition sequence preserves draft revision during pending send', async () => {
  const f = fixture();
  await f.controller.handle(f.edit(1, 'text'));
  const version = f.read().version;
  await f.controller.handle(f.edit(2, 'text', true));
  await f.controller.handle(f.edit(3, 'text'));
  expect(f.read().version).toBe(version);
});

test('revisiting a scope invalidates its older native session', async () => {
  const f = fixture();
  f.controller.bind({ ...f.binding, scope: 'different' });
  f.controller.bind(f.binding);
  expect((await f.controller.handle(f.edit(1, 'late old session'))).error).toBe('expired_session');
  expect(f.read().text).toBe('');
});

test('attachment-only send is allowed when canonical attachment readiness permits it', async () => {
  const f = fixture();
  f.controller.bind({ ...f.binding, state: () => ({ ...f.binding.state(), sendEnabled: true }) });
  expect((await f.controller.handle(f.send(0, ''))).accepted).toBe(true);
  expect(f.sent[0]?.text).toBe('');
});
test('canonical uploading/read-only gate prevents sending without clearing the draft', async () => {
  const f = fixture();
  f.controller.bind({ ...f.binding, state: () => ({ ...f.binding.state(), sendEnabled: false, editable: false }) });
  expect((await f.controller.handle(f.send(1, 'retained'))).error).toBe('unavailable');
  expect(f.read().text).toBe('retained');
  expect(f.sends()).toBe(0);
});

test('workspace controllers share document identity and monotonic publication generations', () => {
  const a = fixture(), b = fixture();
  expect(a.controller.document).toBe(b.controller.document);
  const first = a.controller.snapshot();
  expect(b.controller.snapshot()?.generation).toBeGreaterThan(first?.generation ?? 0);
});
test('send acknowledgment belongs to sent session after scope changes', async () => {
  const f = fixture(); let finish: (ok: boolean) => void = () => {};
  f.controller.bind({ ...f.binding, send: () => new Promise(resolve => { finish = resolve; }) });
  const pending = f.controller.handle(f.send(7, 'sent'));
  f.controller.bind({ ...f.binding, scope: 'new scope' });
  finish(true);
  expect((await pending).ack).toBe(7);
  expect((await pending).state?.ack).toBe(0);
});
test('disposed controller cannot publish stale state or accept late edit after logout', async () => {
  const f = fixture(); let finish: (ok: boolean) => void = () => {};
  f.controller.bind({ ...f.binding, send: () => new Promise(resolve => { finish = resolve; }) });
  const pending = f.controller.handle(f.send(1, 'pending'));
  f.controller.deactivate();
  const count = f.published.length;
  finish(true);
  await pending;
  expect(f.published.length).toBe(count);
  expect((await f.controller.handle(f.edit(2, 'after logout'))).error).toBe('expired_session');
});

test('canonical clear rebases same-sequence attachment-only send', async () => {
  const f = fixture(); let calls = 0;
  f.controller.bind({ ...f.binding, state: () => ({ ...f.binding.state(), sendEnabled: true }),
    send: async () => { calls++; f.binding.write(''); return true; } });
  expect((await f.controller.handle(f.send(1, 'text first'))).accepted).toBe(true);
  expect(f.controller.snapshot()?.text).toBe('');
  expect((await f.controller.handle(f.send(1, ''))).accepted).toBe(true);
  expect(calls).toBe(2);
});
test('published web suggestion rebases current native sequence', async () => {
  const f = fixture();
  f.binding.write('suggestion');
  f.controller.snapshot();
  expect((await f.controller.handle(f.send(0, 'suggestion'))).accepted).toBe(true);
});
