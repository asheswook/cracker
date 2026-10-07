import { expect, test } from 'bun:test';
import { RootReaderAdapter } from '../../src/native-reader-adapter';
import type { ReaderInput } from '../../src/native-reader-adapter';
import type { ReaderPacket, ReaderReplyValue, ReaderSnapshotValue } from '../../src/native-reader-protocol';
const tick = () => new Promise(resolve => setTimeout(resolve, 0));
function fixture() {
  const errors: string[] = [], active: boolean[] = [], calls: ReaderPacket[] = [];
  let fallbacks = 0;
  let finish: (value: ReaderReplyValue) => void = () => {};
  let reject: (reason: Error) => void = () => {};
  let held = false;
  let offset = 800;
  const adapter = new RootReaderAdapter({
    layout: () => ({ width: 400, height: 600, contentHeight: 2000, offset }),
    capture: () => ({ id: 'preserved-message', offset: 0, fallback: 800 }),
    target: anchor => anchor.fallback,
    source: () => null,
    highlight: () => {},
  }, packet => {
    calls.push(packet);
    if (held && packet.kind !== 'release') {
      held = false;
      return new Promise<ReaderReplyValue>((resolve, rejectPromise) => { finish = resolve; reject = rejectPromise; });
    }
    const snapshot: ReaderSnapshotValue = { v: 1, document: packet.document, scope: packet.scope,
      navigation: packet.navigation, sequence: packet.sequence, revision: packet.sequence, interaction: 0, geometry: 1,
      mode: 'reading', offset, width: 400, height: 600, contentHeight: 2000, headerHeight: 120,
      suspended: packet.kind === 'bind' && packet.suspended, dragging: false, keyboardMoving: false };
    return Promise.resolve({ ok: true, snapshot });
  }, { active: value => active.push(value), unread: () => {}, awayFromLatest: () => {}, error: value => errors.push(value), fallback: () => { fallbacks++; } });
  const input: ReaderInput = { scope: 'workspace:one', selected: true, hydrated: true, suspended: false,
    cursor: 31, sourceKey: '', sourceId: null, arrived: false };
  return { adapter, input, calls, errors, active, fallbacks: () => fallbacks, hold: () => { held = true; },
    finish: (reply: ReaderReplyValue = { ok: true }) => finish(reply), reject: () => reject(new Error('reader_timeout')),
    resetOffset: () => { offset = 600; } };
}
for (const outcome of ['reply', 'throw'] as const) {
  test(`old bind ${outcome} after deselect/reselect cannot retire the new reader`, async () => {
    const f = fixture(); f.hold(); f.adapter.configure(f.input); await tick();
    f.adapter.configure({ ...f.input, selected: false }); f.adapter.configure(f.input);
    if (outcome === 'reply') f.finish(); else f.reject();
    await tick();
    expect(f.errors).toEqual([]);
    expect(f.active.at(-1)).toBe(true);
    expect(f.adapter.session.snapshot?.scope).toBe(f.input.scope);
    expect(f.adapter.session.snapshot?.offset).toBe(800);
    f.adapter.dispose();
  });
}
test('old layout failure after navigation cannot retire the new reading session', async () => {
  const f = fixture(); f.adapter.configure(f.input); await tick();
  f.hold(); f.resetOffset(); f.adapter.checkpoint(); await tick();
  expect(f.calls.at(-1)?.kind).toBe('layout');
  f.adapter.configure({ ...f.input, scope: 'workspace:two' }); f.reject(); await tick();
  expect(f.errors).toEqual([]);
  expect(f.active.at(-1)).toBe(true);
  expect(f.adapter.session.snapshot?.scope).toBe('workspace:two');
  f.adapter.dispose();
});
test('current bind failure silently requests newest fallback exactly once', async () => {
  const f = fixture(); f.hold(); f.adapter.configure(f.input); await tick(); f.reject(); await tick();
  expect(f.errors).toEqual([]);
  expect(f.fallbacks()).toBe(1);
  expect(f.active.at(-1)).toBe(false);
  f.adapter.disable();
  expect(f.fallbacks()).toBe(1);
  f.adapter.dispose();
});
test('disposed startup adapter cannot report a late bind timeout into the replacement hook', async () => {
  const f = fixture(); f.hold(); f.adapter.configure(f.input); await tick();
  f.adapter.dispose(); f.reject(); await tick();
  expect(f.errors).toEqual([]);
  expect(f.active.at(-1)).toBe(false);
});
test('superseded suspension bind failure does not retire the resumed reader', async () => {
  const f = fixture(); f.adapter.configure(f.input); await tick();
  f.hold(); f.adapter.configure({ ...f.input, suspended: true }); await tick();
  f.adapter.configure(f.input); f.reject(); await tick();
  expect(f.errors).toEqual([]);
  expect(f.active.at(-1)).toBe(true);
  expect(f.adapter.session.snapshot?.offset).toBe(800);
  expect(f.adapter.session.snapshot?.mode).toBe('reading');
  f.adapter.dispose();
});
for (const outcome of ['throw', 'rejected'] as const) {
test(`old suspension bind ${outcome} cannot retire a later request returning to the same binding state`, async () => {
  const f = fixture(); f.adapter.configure(f.input); await tick();
  f.hold(); f.adapter.configure({ ...f.input, suspended: true }); await tick();
  f.adapter.configure(f.input);
  f.adapter.configure({ ...f.input, suspended: true });
  if (outcome === 'throw') f.reject(); else f.finish({ ok: false, error: 'busy' });
  await tick();
  expect(f.errors).toEqual([]);
  expect(f.active.at(-1)).toBe(true);
  expect(f.adapter.session.snapshot?.suspended).toBe(true);
  expect(f.adapter.session.snapshot?.offset).toBe(800);
  expect(f.adapter.session.snapshot?.mode).toBe('reading');
  f.adapter.dispose();
});
}
