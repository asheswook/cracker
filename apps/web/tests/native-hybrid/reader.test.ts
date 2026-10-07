import { expect, test } from 'bun:test';
import { ReaderSession } from '../../src/native-reader-protocol';
import type { ReaderPacket, ReaderSnapshotValue } from '../../src/native-reader-protocol';
import { RootReaderAdapter } from '../../src/native-reader-adapter';
import type { ReaderInput } from '../../src/native-reader-adapter';
import type { ReaderDOM, ReaderLayout } from '../../src/native-reader-dom';
const tick = () => new Promise(resolve => setTimeout(resolve, 0));
export function fixture(bottomInset?: number) {
  let layout: ReaderLayout = { width: 400, height: 600 - (bottomInset ?? 0), contentHeight: 2000, offset: 1400 + (bottomInset ?? 0) };
  let state: ReaderSnapshotValue = { v: 1, document: crypto.randomUUID(), scope: 'scope', navigation: 1, revision: 1, sequence: 0, interaction: 0, geometry: 1,
    mode: 'follow', width: 400, height: 600, contentHeight: 2000, offset: layout.offset, headerHeight: 120,
    ...(bottomInset === undefined ? {} : { bottomInset }),
    suspended: false, keyboardMoving: false, dragging: false };
  let targetShift = 0, captures = 0, fail = false, rejectMove = false;
  let staleLayout = false;
  let keyboardRace: boolean | null = null;
  let moveGate: Promise<void> | undefined; let finishMove = () => {};
  const calls: ReaderPacket[] = [], highlights: string[] = [], active: boolean[] = [], away: boolean[] = [], unread: boolean[] = [], errors: string[] = [];
  const input: ReaderInput = { scope: 'workspace:one', selected: true, hydrated: true, suspended: false, cursor: 31, sourceKey: '', sourceId: null, arrived: false };
  const dom: ReaderDOM = { layout: () => layout,
    capture: () => { captures++; return { id: 'message-anchor', offset: -10, fallback: layout.offset }; },
    target: anchor => anchor.fallback + targetShift,
    source: id => ({ id: `message-${id}`, offset: 0, fallback: 700 }),
    highlight: id => { highlights.push(id); } };
  const adapter = new RootReaderAdapter(dom, async packet => {
    calls.push(packet);
    if (fail) throw new Error('bridge failed');
    state = { ...state, document: packet.document, scope: packet.scope, navigation: packet.navigation, revision: state.revision + 1, sequence: packet.sequence };
    if (packet.kind === 'bind') state = { ...state, mode: packet.mode, suspended: packet.suspended };
    else if (packet.kind === 'layout' || packet.kind === 'move') {
      if (packet.kind === 'move' && keyboardRace !== null) { const moving = keyboardRace; keyboardRace = null;
        state = { ...state, geometry: state.geometry + 1, keyboardMoving: moving };
        return { ok: false, error: 'stale_geometry', snapshot: state };
      }
      if (packet.kind === 'layout' && staleLayout) { staleLayout = false; targetShift += 100;
        state = { ...state, geometry: state.geometry + 1 }; return { ok: false, error: 'stale_geometry', snapshot: state }; }
      if (state.dragging || state.keyboardMoving || state.suspended || (packet.kind === 'move' && rejectMove)) return { ok: false, error: 'busy', snapshot: state };
      state = { ...state, mode: packet.mode, offset: packet.mode === 'follow' ? state.contentHeight - state.height + (state.bottomInset ?? 0) : packet.offset ?? state.offset };
      layout = { ...layout, offset: state.offset };
    }
    const reply = { ok: true, snapshot: state };
    if (packet.kind === 'move' && moveGate) await moveGate;
    return reply;
  }, { active: value => { active.push(value); }, unread: value => { unread.push(value); }, awayFromLatest: (value: boolean) => { away.push(value); }, error: value => { errors.push(value); } });
  return { adapter, input, calls, highlights, active, unread, away, errors, captureCount: () => captures,
    layout: (next: Partial<ReaderLayout>) => { layout = { ...layout, ...next }; },
    event: (next: Partial<ReaderSnapshotValue>) => { state = { ...state, revision: state.revision + 1, ...next }; adapter.session.receive(state); },
    keyboardRace: (moving = true) => { keyboardRace = moving; }, staleLayout: () => { staleLayout = true; }, holdMove: () => { moveGate = new Promise<void>(resolve => { finishMove = resolve; }); }, finishMove: () => finishMove(),
    shift: (value: number) => { targetShift = value; }, fail: () => { fail = true; }, rejectMove: () => { rejectMove = true; } };
}
test('rotation mixed geometry rejected; matching settled DOM reset corrected once without a timer loop', async () => {
  const f = fixture(); f.adapter.configure(f.input); await tick();
  f.event({ width: 750, height: 270, contentHeight: 4700, geometry: 2, offset: 4034 });
  expect(f.calls.filter(call => call.kind === 'layout')).toHaveLength(0);
  f.layout({ width: 750, height: 270, contentHeight: 4700, offset: 4034 });
  f.adapter.checkpoint(); await tick();
  expect(f.calls.filter(call => call.kind === 'layout')).toHaveLength(1);
  expect(f.adapter.session.snapshot?.offset).toBe(4430);
  f.layout({ offset: 4034 }); f.event({ offset: 4034 });
  for (let i = 0; i < 20; i++) f.adapter.checkpoint();
  await tick();
  expect(f.calls.filter(call => call.kind === 'layout')).toHaveLength(1);
});
test('matching no-op geometry does not consume the one later reset correction', async () => {
  const f = fixture(); f.adapter.configure(f.input); await tick();
  expect(f.calls.filter(call => call.kind === 'layout')).toHaveLength(0);
  f.layout({ offset: 1100 }); f.event({ offset: 1100 }); await tick();
  expect(f.calls.filter(call => call.kind === 'layout')).toHaveLength(1);
});
test('physical drag epoch overrides follow, captures anchor only after settled coherent DOM', async () => {
  const f = fixture(); f.adapter.configure(f.input); await tick();
  f.event({ interaction: 1, mode: 'reading', dragging: true, offset: 800 });
  expect(f.captureCount()).toBe(0);
  f.layout({ width: 300, offset: 800 });
  f.event({ dragging: false }); expect(f.captureCount()).toBe(0);
  f.layout({ width: 400 }); f.adapter.checkpoint();
  expect(f.captureCount()).toBe(1);
  f.adapter.configure({ ...f.input, arrived: true, cursor: 32 });
  expect(f.unread.at(-1)).toBe(true);
  expect(f.calls.filter(call => call.kind === 'layout')).toHaveLength(0);
});
test('reader anchor reflows once while reading and suspension preserves mode without restore writes', async () => {
  const f = fixture(); f.adapter.configure(f.input); await tick();
  f.layout({ offset: 800 }); f.event({ interaction: 1, mode: 'reading', dragging: true, offset: 800 });
  f.event({ dragging: false });
  f.adapter.configure({ ...f.input, suspended: true }); await tick();
  f.shift(100); f.layout({ contentHeight: 2100 }); f.event({ geometry: 2, contentHeight: 2100 });
  expect(f.calls.filter(call => call.kind === 'layout')).toHaveLength(0);
  f.adapter.configure(f.input); await tick();
  expect(f.adapter.session.snapshot?.mode).toBe('reading');
  expect(f.adapter.session.snapshot?.offset).toBe(900);
});
test('source scope waits hydration then positions/highlights exact source; new drag cancels source hold', async () => {
  const f = fixture();
  const input = { ...f.input, sourceKey: 'source-id', sourceId: 'source-id', hydrated: false };
  f.adapter.configure(input); await tick();
  expect(f.calls.filter(call => call.kind === 'layout')).toHaveLength(0);
  f.adapter.configure({ ...input, hydrated: true }); await tick();
  expect(f.adapter.session.snapshot?.offset).toBe(700);
  expect(f.highlights).toEqual(['message-source-id']);
  f.layout({ offset: 500 }); f.event({ interaction: 1, mode: 'reading', dragging: true, offset: 500 });
  f.event({ dragging: false }); f.adapter.checkpoint(); await tick();
  expect(f.adapter.session.snapshot?.offset).toBe(500);
});
test('latest busy rejection preserves unread and does not auto replay', async () => {
  const f = fixture(); f.adapter.configure(f.input); await tick();
  f.layout({ offset: 800 }); f.event({ interaction: 1, mode: 'reading', dragging: true, offset: 800 }); f.event({ dragging: false });
  f.adapter.configure({ ...f.input, arrived: true }); f.rejectMove();
  expect(await f.adapter.latest()).toBe(false);
  expect(f.unread.at(-1)).toBe(true);
  await tick(); expect(f.calls.filter(call => call.kind === 'move')).toHaveLength(1);
});
test('keyboard-moving resize never issues anchor/tail corrections until settled snapshot', async () => {
  const f = fixture(); f.adapter.configure(f.input); await tick();
  f.layout({ height: 300, offset: 1400 }); f.event({ height: 300, geometry: 2, keyboardMoving: true });
  f.adapter.checkpoint(); await tick(); expect(f.calls.filter(call => call.kind === 'layout')).toHaveLength(0);
  f.event({ keyboardMoving: false }); await tick(); expect(f.calls.filter(call => call.kind === 'layout')).toHaveLength(1);
});
test('failed initial bridge leaves native mode inactive without a recovery message', async () => {
  const f = fixture(); f.fail(); f.adapter.configure(f.input); await tick();
  expect(f.active).toEqual([false]); expect(f.errors).toEqual([]);
});
test('queued stale follow never reaches transport after immediate physical drag invalidation', async () => {
  let release: () => void = () => {};
  const calls: ReaderPacket[] = [];
  let snapshot: ReaderSnapshotValue;
  const session = new ReaderSession(async packet => {
    calls.push(packet);
    if (packet.kind === 'bind') {
      snapshot = { v: 1, document: packet.document, scope: packet.scope, navigation: packet.navigation, revision: packet.sequence, sequence: packet.sequence, interaction: 0, geometry: 1,
        mode: 'follow', offset: 0, width: 400, height: 600, contentHeight: 2000, headerHeight: 120,
        suspended: false, dragging: false, keyboardMoving: false };
      return { ok: true, snapshot };
    }
    await new Promise<void>(resolve => { release = resolve; });
    return { ok: true };
  }, () => {});
  await session.bind({ key: 'one', scope: 'one', mode: 'follow', suspended: false });
  const first = session.send({ kind: 'layout', interaction: 0, geometry: 1, width: 400, height: 600, contentHeight: 2000, mode: 'follow' });
  await Promise.resolve();
  const stale = session.send({ kind: 'move', interaction: 0, geometry: 1, mode: 'follow' });
  const current = session.snapshot;
  if (!current) throw new Error('Missing snapshot');
  session.receive({ ...current, revision: current.revision + 1, interaction: 1, mode: 'reading', dragging: true });
  release(); await first;
  expect((await stale).error).toBe('stale_interaction');
  expect(calls.filter(call => call.kind === 'move')).toHaveLength(0);
});

test('settled native offset before DOM publication does not capture stale reader anchor', async () => {
  const f = fixture(); f.adapter.configure(f.input); await tick();
  f.event({ interaction: 1, mode: 'reading', dragging: true, offset: 800 });
  f.event({ dragging: false });
  expect(f.captureCount()).toBe(0);
  expect(f.calls.filter(call => call.kind === 'layout')).toHaveLength(0);
  f.layout({ offset: 800 }); f.adapter.checkpoint();
  expect(f.captureCount()).toBe(1);
});
test('same interaction older command snapshot cannot regress accepted mode; physical interaction remains authoritative', async () => {
  const f = fixture(); f.adapter.configure(f.input); await tick();
  const initial = f.adapter.session.snapshot!;
  expect(f.adapter.session.receive({ ...initial, revision: initial.revision + 1, sequence: 5, mode: 'reading' })).toBe(true);
  expect(f.adapter.session.receive({ ...initial, revision: initial.revision + 2, sequence: 4, mode: 'follow' })).toBe(false);
  expect(f.adapter.session.snapshot?.mode).toBe('reading');
  expect(f.adapter.session.receive({ ...initial, revision: initial.revision + 3, sequence: 4, interaction: 1, mode: 'reading', dragging: true })).toBe(true);
});
test('deselection releases root ownership and reselect binds a fresh navigation', async () => {
  const f = fixture(); f.adapter.configure(f.input); await tick();
  const navigation = f.adapter.session.navigation;
  f.adapter.configure({ ...f.input, selected: false });
  expect(f.active.at(-1)).toBe(false);
  expect(f.calls.at(-1)?.kind).toBe('release');
  const releasedDocument = f.calls.at(-1)?.document;
  f.adapter.configure(f.input); await tick();
  expect(f.adapter.session.navigation).toBeGreaterThan(navigation);
  expect(f.calls.at(-1)?.document).not.toBe(releasedDocument);
  expect(f.active.at(-1)).toBe(true);
});

test('in-flight accepted latest reply cannot clear unread after a newer physical drag', async () => {
  const f = fixture(); f.adapter.configure(f.input); await tick();
  f.layout({ offset: 800 }); f.event({ interaction: 1, mode: 'reading', dragging: true, offset: 800 }); f.event({ dragging: false });
  f.adapter.configure({ ...f.input, arrived: true }); f.holdMove();
  const result = f.adapter.latest(); await Promise.resolve();
  f.layout({ offset: 700 }); f.event({ interaction: 2, mode: 'reading', dragging: true, offset: 700 });
  f.finishMove(); expect(await result).toBe(false);
  expect(f.unread.at(-1)).toBe(true);
  expect(f.adapter.session.snapshot?.mode).toBe('reading');
});

test('queued absolute target is discarded when native geometry epoch changes', async () => {
  let release = () => {}; const calls: ReaderPacket[] = [];
  const session = new ReaderSession(async packet => {
    calls.push(packet);
    if (packet.kind === 'bind') return { ok: true, snapshot: { v: 1, document: packet.document, scope: packet.scope,
      navigation: packet.navigation, revision: packet.sequence, sequence: packet.sequence, interaction: 0, geometry: 1, mode: 'reading',
      offset: 800, width: 400, height: 600, contentHeight: 2000, headerHeight: 120, suspended: false, dragging: false, keyboardMoving: false } };
    await new Promise<void>(resolve => { release = resolve; }); return { ok: true };
  }, () => {});
  await session.bind({ key: 'one', scope: 'one', mode: 'reading', suspended: false });
  const first = session.send({ kind: 'move', interaction: 0, geometry: 1, mode: 'reading', offset: 800 }); await Promise.resolve();
  const stale = session.send({ kind: 'layout', interaction: 0, geometry: 1, width: 400, height: 600, contentHeight: 2000, mode: 'reading', offset: 900 });
  session.receive({ ...session.snapshot!, revision: session.snapshot!.revision + 1, geometry: 2 }); release(); await first;
  expect((await stale).error).toBe('stale_geometry');
  expect(calls.filter(call => call.kind === 'layout')).toHaveLength(0);
  await session.bind({ key: 'two', scope: 'two', mode: 'reading', suspended: false });
  expect(calls.at(-1)).toMatchObject({ kind: 'bind', scope: 'two', interaction: 0 });
});

test('stale layout epoch remeasures coherent anchor target instead of replaying old absolute offset', async () => {
  const f = fixture(); f.adapter.configure(f.input); await tick();
  f.layout({ offset: 800 }); f.event({ interaction: 1, mode: 'reading', dragging: true, offset: 800 }); f.event({ dragging: false });
  f.shift(100); f.staleLayout(); f.adapter.checkpoint(); await tick();
  const layouts = f.calls.filter(call => call.kind === 'layout');
  expect(layouts).toHaveLength(2);
  expect(layouts[0]).toMatchObject({ geometry: 1, offset: 900 });
  expect(layouts[1]).toMatchObject({ geometry: 2, offset: 1000 });
  expect(f.adapter.session.snapshot?.offset).toBe(1000);
});

test('clearing source navigation preserves anchor and returns to reading mode', async () => {
  const f = fixture(); f.adapter.configure({ ...f.input, sourceKey: 'source', sourceId: 'source' }); await tick();
  expect(f.adapter.session.snapshot?.mode).toBe('source');
  const corrections = f.calls.filter(call => call.kind === 'layout').length;
  f.adapter.configure(f.input); await tick();
  expect(f.adapter.session.snapshot?.mode).toBe('reading');
  expect(f.adapter.session.snapshot?.offset).toBe(700);
  expect(f.calls.filter(call => call.kind === 'layout')).toHaveLength(corrections);
});

test('older native event cannot replace newer reply offset at equal sequence; equal revision is immutable', async () => {
  const f = fixture(); f.adapter.configure(f.input); await tick();
  const before = f.adapter.session.snapshot!;
  const reply = { ...before, revision: before.revision + 2, offset: 1000, mode: 'reading' as const };
  expect(f.adapter.session.receive(reply, false)).toBe(true);
  expect(f.adapter.session.receive({ ...before, revision: before.revision + 1, offset: 800 })).toBe(false);
  expect(f.adapter.session.snapshot?.offset).toBe(1000);
  expect(f.adapter.session.receive({ ...reply, offset: 900 })).toBe(false);
  expect(f.adapter.session.receive(reply)).toBe(true);
  expect(f.adapter.session.snapshot?.offset).toBe(1000);
});

test('actual first-tap trace: keyboard invalidates issued geometry, one settled fresh latest follows without second tap', async () => {
  const f = fixture(); const input = { ...f.input, sourceKey: 'source29', sourceId: '29' };
  f.adapter.configure(input); await tick(); f.adapter.configure({ ...input, arrived: true });
  f.keyboardRace(); let resolved: boolean | undefined;
  const first = f.adapter.latest().then(value => { resolved = value; return value; });
  await tick(); expect(resolved).toBeUndefined();
  expect(f.unread.at(-1)).toBe(true);
  const layouts = f.calls.filter(call => call.kind === 'layout').length;
  f.adapter.checkpoint(); expect(f.calls.filter(call => call.kind === 'layout')).toHaveLength(layouts);
  f.event({ keyboardMoving: false });
  expect(await first).toBe(true);
  expect(f.calls.filter(call => call.kind === 'move')).toHaveLength(2);
  const moves = f.calls.filter(call => call.kind === 'move');
  expect(moves[0]?.geometry).toBe(1); expect(moves[1]?.geometry).toBe(2);
  expect(f.adapter.session.snapshot?.mode).toBe('follow');
  expect(f.adapter.session.snapshot?.offset).toBe(1400); expect(f.unread.at(-1)).toBe(false);
  f.adapter.checkpoint(); await tick(); expect(f.adapter.session.snapshot?.offset).toBe(1400);
});
for (const cancel of ['drag', 'source', 'panel', 'rotation', 'dispose'] as const) {
  test(`pending keyboard latest is canceled by ${cancel}, never replayed on later keyboard-did`, async () => {
    const f = fixture(); const input = { ...f.input, sourceKey: 'source29', sourceId: '29' };
    f.adapter.configure(input); await tick(); f.adapter.configure({ ...input, arrived: true }); f.keyboardRace();
    const first = f.adapter.latest(); await tick();
    if (cancel === 'drag') f.event({ interaction: 1, dragging: true, mode: 'reading' });
    if (cancel === 'source') f.adapter.configure({ ...input, sourceKey: 'source15', sourceId: '15' });
    if (cancel === 'panel') f.adapter.configure({ ...input, suspended: true });
    if (cancel === 'rotation') f.event({ width: 750, geometry: 3 });
    if (cancel === 'dispose') f.adapter.dispose();
    expect(await first).toBe(false);
    f.event({ keyboardMoving: false }); await tick();
    expect(f.calls.filter(call => call.kind === 'move')).toHaveLength(1);
  });
}

test('non-keyboard geometry rejection never becomes an automatic latest replay', async () => {
  const f = fixture(); f.adapter.configure(f.input); await tick(); f.keyboardRace(false);
  expect(await f.adapter.latest()).toBe(false); f.event({ keyboardMoving: false }); await tick();
  expect(f.calls.filter(call => call.kind === 'move')).toHaveLength(1);
});
test('repeated taps share pending explicit intent; a second rejection never generates a third move', async () => {
  const f = fixture(); f.adapter.configure(f.input); await tick(); f.keyboardRace();
  const first = f.adapter.latest(); await tick(); expect(f.adapter.latest()).toBe(first);
  f.keyboardRace(); f.event({ keyboardMoving: false });
  expect(await first).toBe(false); f.event({ keyboardMoving: false }); await tick();
  expect(f.calls.filter(call => call.kind === 'move')).toHaveLength(2);
});
test('cancelled queued semantic intent is discarded before native transport', async () => {
  const calls: ReaderPacket[] = [];
  const session = new ReaderSession(async packet => { calls.push(packet); return { ok: true }; }, () => {});
  await session.bind({ key: 'one', scope: 'one', mode: 'reading', suspended: false });
  let current = true;
  const command = session.send({ kind: 'move', interaction: 0, geometry: 0, mode: 'follow' }, () => current);
  current = false;
  expect((await command).error).toBe('cancelled_intent');
  expect(calls.filter(call => call.kind === 'move')).toHaveLength(0);
});
test('an uncompleted keyboard transition expires explicit intent and cannot revive after a later settled event', async () => {
  const f = fixture(); f.adapter.configure(f.input); await tick();
  f.event({ keyboardMoving: true }); const first = f.adapter.latest();
  expect(await first).toBe(false);
  f.event({ keyboardMoving: false }); await tick();
  expect(f.calls.filter(call => call.kind === 'move')).toHaveLength(0);
});
test('earlier keyboard wait does not authorize replay of an unrelated later geometry rejection', async () => {
  const f = fixture(); f.adapter.configure(f.input); await tick();
  f.event({ keyboardMoving: true }); const first = f.adapter.latest();
  f.keyboardRace(false); f.event({ keyboardMoving: false });
  expect(await first).toBe(false);
  expect(f.calls.filter(call => call.kind === 'move')).toHaveLength(1);
});

test('follow tail reconciles compact landscape width-height-header epoch and restores portrait tail', async () => {
  const f = fixture(); f.adapter.configure(f.input); await tick();
  f.layout({ width: 750, height: 114, contentHeight: 4898, offset: 1400 });
  f.event({ width: 750, height: 114, contentHeight: 4898, offset: 1400, headerHeight: 52, geometry: 2 });
  await tick(); expect(f.adapter.session.snapshot?.offset).toBe(4784);
  expect(f.adapter.session.snapshot?.mode).toBe('follow');
  f.layout({ width: 400, height: 600, contentHeight: 2000, offset: 1400 });
  f.event({ width: 400, height: 600, contentHeight: 2000, offset: 1400, headerHeight: 122, geometry: 3 });
  await tick(); expect(f.adapter.session.snapshot?.offset).toBe(1400);
  expect(f.adapter.session.snapshot?.mode).toBe('follow');
});
