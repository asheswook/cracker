import { expect, test } from 'bun:test';
import { fixture } from './reader.test';
const tick = () => new Promise(resolve => setTimeout(resolve, 0));

test('native composer overlay snapshot keeps the reader active at the unobscured tail', async () => {
  const f = fixture(160); f.adapter.configure(f.input); await tick();
  expect(f.adapter.session.snapshot?.bottomInset).toBe(160);
  expect(f.active.at(-1)).toBe(true);
  expect(f.calls.filter(call => call.kind === 'layout')).toHaveLength(0);
  expect(f.away.at(-1) ?? false).toBe(false);
  f.adapter.dispose();
});

test('latest remains available when the tail is behind the composer and clears after navigation', async () => {
  const f = fixture(160); f.adapter.configure(f.input); await tick();
  f.layout({ offset: 1400 }); f.event({ interaction: 1, mode: 'reading', dragging: true, offset: 1400 });
  f.event({ dragging: false });
  expect(f.away.at(-1)).toBe(true);
  expect(await f.adapter.latest()).toBe(true);
  expect(f.adapter.session.snapshot?.offset).toBe(1560);
  expect(f.away.at(-1)).toBe(false);
  f.adapter.dispose();
});

test('reading anchor below the old viewport maximum is preserved across reflow', async () => {
  const f = fixture(160); f.adapter.configure(f.input); await tick();
  f.layout({ offset: 1490 }); f.event({ interaction: 1, mode: 'reading', dragging: true, offset: 1490 });
  f.event({ dragging: false });
  f.shift(20); f.event({ geometry: 2 }); await tick();
  expect(f.adapter.session.snapshot?.offset).toBe(1510);
  f.adapter.dispose();
});

test('growing composer inset advances follow once without changing physical viewport height', async () => {
  const f = fixture(160); f.adapter.configure(f.input); await tick();
  f.layout({ height: 400 });
  f.event({ bottomInset: 200, geometry: 2 }); await tick();
  expect(f.adapter.session.snapshot?.offset).toBe(1600);
  const moves = f.calls.filter(call => call.kind === 'layout');
  expect(moves).toHaveLength(1);
  expect(moves[0]).toMatchObject({ height: 600, contentHeight: 2000, geometry: 2 });
  f.adapter.checkpoint(); await tick();
  expect(f.calls.filter(call => call.kind === 'layout')).toHaveLength(1);
  f.adapter.dispose();
});

test('overlay layout rejects DOM heights outside the physical and inset-adjusted viewport bounds', async () => {
  const f = fixture(160); f.adapter.configure(f.input); await tick();
  f.layout({ height: 640, offset: 1500 }); f.event({ offset: 1500, geometry: 2 }); await tick();
  expect(f.calls.filter(call => call.kind === 'layout')).toHaveLength(0);
  f.layout({ height: 440 }); f.adapter.checkpoint(); await tick();
  expect(f.calls.filter(call => call.kind === 'layout')).toHaveLength(1);
  expect(f.adapter.session.snapshot?.offset).toBe(1560);
  f.adapter.dispose();
});

test('history scrolling can restore the physical DOM viewport without losing its reading anchor', async () => {
  const f = fixture(160); f.adapter.configure(f.input); await tick();
  f.layout({ height: 600, offset: 1490 }); f.event({ interaction: 1, mode: 'reading', dragging: true, offset: 1490 });
  f.event({ dragging: false });
  f.shift(20); f.event({ geometry: 2 }); await tick();
  expect(f.adapter.session.snapshot?.offset).toBe(1510);
  expect(f.calls.filter(call => call.kind === 'layout')).toHaveLength(1);
  expect(f.away.at(-1)).toBe(true);
  f.adapter.dispose();
});
