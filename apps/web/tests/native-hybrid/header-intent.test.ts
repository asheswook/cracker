import { expect, test } from 'bun:test';
import { HeaderBodySession, HeaderRenderSession } from '../../src/independent-header-protocol';
import type { HeaderActionName, HeaderPropsValue } from '../../src/independent-header-protocol';
import { defaultAppearance } from '../../src/appearance/types';
function fixture(result: 'ok' | 'unavailable' | 'throw' = 'ok') {
  const calls: HeaderActionName[] = [];
  const body = new HeaderBodySession(action => {
    calls.push(action);
    if (result === 'throw') throw new TypeError('Action failed');
    return result === 'ok';
  });
  const header = new HeaderRenderSession(crypto.randomUUID());
  const props: HeaderPropsValue = { name: 'Assistant', archiveTitle: 'Archive', connected: true, working: false,
    computerOpen: false, appearance: defaultAppearance, scheme: 'light', time: { available: true, pinned: false } };
  const input = { scope: 'same-conversation', visible: true, props };
  const first = body.update(input);
  if (!first) throw new TypeError('Missing initial header state');
  expect(header.receive({ ...first, headerDocument: header.document }).ok).toBe(true);
  const event = { v: 1, document: body.document, headerDocument: header.document, scope: first.scope, generation: first.generation };
  expect(body.handle({ ...event, kind: 'activate' }).ok).toBe(true);
  const click = (action: HeaderActionName) => ({ ...event, kind: 'action', commandId: crypto.randomUUID(), action });
  return { body, header, input, event, click, calls };
}
for (const action of ['menu', 'settings', 'computer', 'time-toggle', 'archive-return'] as const) {
  test(`visible ${action} intent survives cosmetic updates while retaining exactly-once delivery`, () => {
    const f = fixture(), command = f.click(action);
    f.body.update({ ...f.input, props: { ...f.input.props, working: true } });
    f.body.update({ ...f.input, props: { ...f.input.props, connected: false, name: 'Renamed' } });
    expect(f.body.handle(command)).toEqual({ ok: true });
    expect(f.body.handle(command)).toEqual({ ok: true });
    expect(f.calls).toEqual([action]);
  });
}
for (const action of ['menu', 'settings', 'computer', 'time-toggle', 'archive-return'] as const) {
  for (const transition of ['hidden', 'scope'] as const) {
    test(`${action} intent cannot cross ${transition} change and return to the same visible context`, () => {
      const f = fixture(), command = f.click(action);
      f.body.update({ ...f.input, ...(transition === 'hidden' ? { visible: false } : { scope: 'another-conversation' }) });
      const returned = f.body.update(f.input);
      if (!returned) throw new TypeError('Missing returned header state');
      expect(f.body.handle({ ...f.event, kind: 'activate', generation: returned.generation }).ok).toBe(true);
      expect(f.body.handle(command)).toEqual({ ok: false, error: 'stale_event' }); expect(f.calls).toEqual([]);
    });
  }
}
test('same-context old intent respects current archive and time availability', () => {
  const f = fixture();
  const archive = f.click('archive-return'), time = f.click('time-toggle');
  f.body.update({ ...f.input, props: { ...f.input.props, archiveTitle: null, time: { available: false, pinned: false } } });
  expect(f.body.handle(archive)).toEqual({ ok: false, error: 'archive_unavailable' });
  expect(f.body.handle(time)).toEqual({ ok: false, error: 'time_unavailable' }); expect(f.calls).toEqual([]);
});
test('cosmetic tolerance does not admit future generation or different document/header/scope', () => {
  const f = fixture(), command = f.click('menu');
  f.body.update({ ...f.input, props: { ...f.input.props, working: true } });
  for (const invalid of [{ generation: 100 }, { document: crypto.randomUUID() }, { headerDocument: crypto.randomUUID() }, { scope: 'another' }]) {
    expect(f.body.handle({ ...command, ...invalid }).ok).toBe(false);
  }
  expect(f.calls).toEqual([]);
});
test('activate and fallback remain exact-current-generation after cosmetic update', () => {
  const f = fixture(); f.body.update({ ...f.input, props: { ...f.input.props, working: true } });
  expect(f.body.handle({ ...f.event, kind: 'activate' })).toEqual({ ok: false, error: 'stale_event' });
  expect(f.body.handle({ ...f.event, kind: 'fallback' })).toEqual({ ok: false, error: 'stale_event' });
});
test('hidden current header still rejects current-generation action', () => {
  const f = fixture(); const hidden = f.body.update({ ...f.input, visible: false });
  if (!hidden) throw new TypeError('Missing hidden state');
  expect(f.body.handle({ ...f.click('menu'), generation: hidden.generation })).toEqual({ ok: false, error: 'inactive_header' });
  expect(f.calls).toEqual([]);
});

test('two distinct old intents execute once before hide and never revive after returning', () => {
  const f = fixture(), menu = f.click('menu'), settings = f.click('settings');
  f.body.update({ ...f.input, props: { ...f.input.props, working: true } });
  expect(f.body.handle(menu).ok).toBe(true); expect(f.body.handle(settings).ok).toBe(true);
  f.body.update({ ...f.input, visible: false });
  const returned = f.body.update(f.input);
  if (!returned) throw new TypeError('Missing returned state');
  expect(f.body.handle({ ...f.event, kind: 'activate', generation: returned.generation }).ok).toBe(true);
  expect(f.body.handle(menu).ok).toBe(false); expect(f.body.handle(settings).ok).toBe(false);
  expect(f.calls).toEqual(['menu', 'settings']);
  expect(f.body.handle({ ...f.click('menu'), generation: returned.generation }).ok).toBe(true);
  expect(f.calls).toEqual(['menu', 'settings', 'menu']);
});
test('header reload starts a fresh action generation floor', () => {
  const f = fixture(), command = f.click('menu');
  const current = f.body.update({ ...f.input, props: { ...f.input.props, working: true } });
  if (!current) throw new TypeError('Missing current state');
  const headerDocument = crypto.randomUUID();
  expect(f.body.handle({ ...f.event, kind: 'activate', headerDocument, generation: current.generation }).ok).toBe(true);
  expect(f.body.handle(command).ok).toBe(false);
  expect(f.body.handle({ ...command, headerDocument }).ok).toBe(false);
  expect(f.body.handle({ ...command, headerDocument, generation: current.generation }).ok).toBe(true);
  expect(f.calls).toEqual(['menu']);
});
test('body document reload cannot inherit preceding document intent', () => {
  const first = fixture(), next = fixture();
  expect(next.body.handle(first.click('menu')).ok).toBe(false);
  expect(next.calls).toEqual([]);
});
for (const result of ['throw', 'unavailable'] as const) {
  test(`same-context action ${result} result remains cached and does not replay callback`, () => {
    const f = fixture(result), command = f.click('menu');
    f.body.update({ ...f.input, props: { ...f.input.props, working: true } });
    const error = result === 'throw' ? 'action_failed' : 'action_unavailable';
    expect(f.body.handle(command)).toEqual({ ok: false, error });
    f.body.update({ ...f.input, props: { ...f.input.props, connected: false } });
    expect(f.body.handle(command)).toEqual({ ok: false, error });
    expect(f.calls).toEqual(['menu']);
  });
}
