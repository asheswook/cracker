import { expect, test } from 'bun:test';
import { compareNewestCreated } from '../apps/web/src/recent-order';

test('newest creation comes first across timezone offsets, preserving equal-time source order', () => {
  const records = Object.freeze([
    { id: 'old', created_at: '2026-10-01T00:00:00Z' },
    { id: 'tie-first', created_at: '2026-10-03T09:00:00+09:00' },
    { id: 'newest', created_at: '2026-10-03T01:00:00Z' },
    { id: 'tie-second', created_at: '2026-10-03T00:00:00Z' },
  ]);
  const result = [...records].sort(compareNewestCreated);
  expect(result.map(item => item.id)).toEqual(['newest', 'tie-first', 'tie-second', 'old']);
  expect(records.map(item => item.id)).toEqual(['old', 'tie-first', 'newest', 'tie-second']);
  expect(result[0]).toBe(records[2]);
});

test('unparseable dates allowed by current string schemas sort last without disturbing valid chronology', () => {
  const records = [
    { id: 'invalid-first', created_at: 'not-a-date' },
    { id: 'old', created_at: '2026-10-01T00:00:00Z' },
    { id: 'invalid-second', created_at: '' },
    { id: 'new', created_at: '2026-10-03T00:00:00Z' },
  ];
  expect([...records].sort(compareNewestCreated).map(item => item.id))
    .toEqual(['new', 'old', 'invalid-first', 'invalid-second']);
  expect(compareNewestCreated({ created_at: 'not-a-date' }, { created_at: '' })).toBe(0);
});
