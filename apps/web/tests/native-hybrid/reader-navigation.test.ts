import { expect, test } from 'bun:test';
import { fixture } from './reader.test';
const tick = () => new Promise(resolve => setTimeout(resolve, 0));
async function readingFixture() {
  const f = fixture(); f.adapter.configure(f.input); await tick();
  f.layout({ offset: 800 }); f.event({ interaction: 1, mode: 'reading', dragging: true, offset: 800 });
  f.event({ dragging: false });
  return f;
}
test('latest navigation appears after scroll away without a new arrival', async () => {
  const f = await readingFixture();
  expect(f.away.at(-1)).toBe(true);
  expect(f.unread.at(-1) ?? false).toBe(false);
});
test('latest navigation hides after returning to the tail', async () => {
  const f = await readingFixture();
  f.layout({ offset: 1400 }); f.event({ interaction: 2, mode: 'follow', offset: 1400 });
  expect(f.away.at(-1)).toBe(false);
});
test('unread arrival state remains independent of latest navigation', async () => {
  const f = await readingFixture();
  f.adapter.configure({ ...f.input, arrived: true, cursor: 32 });
  expect(f.away.at(-1)).toBe(true);
  expect(f.unread.at(-1)).toBe(true);
});
test('latest navigation is cleared immediately when reader is suspended', async () => {
  const f = await readingFixture();
  f.adapter.configure({ ...f.input, suspended: true });
  expect(f.away.at(-1)).toBe(false);
});
test('resume derives latest navigation from the current reader snapshot', async () => {
  const f = await readingFixture();
  f.adapter.configure({ ...f.input, suspended: true }); await tick();
  f.adapter.configure(f.input); await tick();
  expect(f.away.at(-1)).toBe(true);
});
test('archive rebind clears old scope navigation before its own snapshot arrives', async () => {
  const f = await readingFixture();
  f.adapter.configure({ ...f.input, scope: 'archive:new', cursor: 1 });
  expect(f.away.at(-1)).toBe(false);
});
test('released scope rejects old events and keeps latest navigation cleared', async () => {
  const f = await readingFixture();
  const prior = f.adapter.session.snapshot;
  if (!prior) throw new TypeError('Missing fixture snapshot');
  f.adapter.configure({ ...f.input, selected: false });
  expect(f.adapter.session.receive({ ...prior, revision: prior.revision + 1 })).toBe(false);
  expect(f.away.at(-1)).toBe(false);
});
test('reader failure clears obsolete latest navigation', async () => {
  const f = await readingFixture();
  f.adapter.disable(false);
  expect(f.away.at(-1)).toBe(false);
});
test('dragging and keyboard transitions do not resize footer before settling', async () => {
  const f = fixture(); f.adapter.configure(f.input); await tick();
  f.layout({ offset: 800 }); f.event({ interaction: 1, mode: 'reading', dragging: true, offset: 800 });
  expect(f.away.at(-1) ?? false).toBe(false);
  f.event({ dragging: false, keyboardMoving: true });
  expect(f.away.at(-1) ?? false).toBe(false);
  f.event({ keyboardMoving: false });
  expect(f.away.at(-1)).toBe(true);
});
test('pending suspension cannot be undone by an earlier unsuspended snapshot', async () => {
  const f = await readingFixture();
  f.adapter.configure({ ...f.input, suspended: true });
  f.event({ suspended: false });
  expect(f.away.at(-1)).toBe(false);
});
test('archive snapshot derives its own tail visibility without the prior scope state', async () => {
  const f = await readingFixture();
  f.layout({ offset: 1400 }); f.event({ offset: 1400 });
  f.adapter.configure({ ...f.input, scope: 'archive:new', cursor: 1 }); await tick();
  expect(f.away.at(-1)).toBe(false);
  expect(f.adapter.session.snapshot?.scope).toBe('archive:new');
});
test('returning within native follow threshold hides latest without changing unread arrival semantics', async () => {
  const f = await readingFixture();
  f.layout({ offset: 1380 }); f.event({ interaction: 2, mode: 'follow', offset: 1380 });
  expect(f.away.at(-1)).toBe(false);
  expect(f.unread.at(-1) ?? false).toBe(false);
});
test('successful explicit latest clears navigation and unread', async () => {
  const f = await readingFixture(); f.adapter.configure({ ...f.input, arrived: true });
  expect(await f.adapter.latest()).toBe(true);
  expect(f.away.at(-1)).toBe(false);
  expect(f.unread.at(-1)).toBe(false);
});
