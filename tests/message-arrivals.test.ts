import { describe, expect, test } from 'bun:test';
import { hasNewTailMessages, newTailMessageKeys, type MessageArrivalSnapshot } from '../apps/web/src/messageArrivals';
import { Id } from '../apps/web/src/types';

const conversation = Id.parse('11111111-1111-4111-8111-111111111111');
const other = Id.parse('22222222-2222-4222-8222-222222222222');
function snapshot(sequences: readonly number[], historyLoaded = true): MessageArrivalSnapshot {
  return {
    selected: conversation, syncedCursor: historyLoaded ? Math.max(0, ...sequences) : null, pending: [],
    messages: sequences.map(sequence => ({
      id: Id.parse(`33333333-3333-4333-8333-${String(sequence).padStart(12, '0')}`),
      client_message_id: null, sequence,
    })),
  };
}

describe('new-message indicator distinguishes arrivals from historical hydration', () => {
  test('draft-only renders reuse the empty arrival result without scanning history', () => {
    const current = snapshot([1, 2, 3]);
    const idle = newTailMessageKeys(current, current);
    const messages = new Proxy(current.messages, { get(target, key, receiver) {
      if (key === 'map' || key === 'filter') throw new Error('Unchanged history was scanned');
      return Reflect.get(target, key, receiver);
    } });
    const unchanged = { ...current, messages };
    expect(newTailMessageKeys(unchanged, unchanged)).toBe(idle);
    expect(idle.size).toBe(0);
    expect(newTailMessageKeys(current, snapshot([1, 2, 3, 4])).size).toBe(1);
  });
  test('source-first history establishes a baseline even when every older message follows the source', () => {
    expect(hasNewTailMessages(snapshot([1], false), snapshot([1, 2, 3]))).toBe(false);
    expect(hasNewTailMessages(snapshot([5], false), snapshot([1, 5, 8]))).toBe(false);
  });
  test('genuine tail arrivals follow hydration, including an initially empty conversation', () => {
    expect(hasNewTailMessages(snapshot([1, 5, 8]), snapshot([1, 5, 8, 9]))).toBe(true);
    expect(hasNewTailMessages(snapshot([]), snapshot([1]))).toBe(true);
  });
  test('prepend, interior source fill, and same identity updates are not arrivals', () => {
    expect(hasNewTailMessages(snapshot([5, 8]), snapshot([1, 5, 8]))).toBe(false);
    expect(hasNewTailMessages(snapshot([1, 8]), snapshot([1, 5, 8]))).toBe(false);
    expect(hasNewTailMessages(snapshot([1, 5, 8]), snapshot([1, 5, 8]))).toBe(false);
  });
  test('a prepend does not hide a simultaneous genuine new tail', () => {
    expect(hasNewTailMessages(snapshot([5, 8]), snapshot([1, 5, 8, 9]))).toBe(true);
    expect([...newTailMessageKeys(snapshot([5, 8]), snapshot([1, 5, 8, 9]))]).toEqual(snapshot([9]).messages.map(message => message.id));
  });
  test('same-length replacement with a new tail is still an arrival', () => {
    expect(hasNewTailMessages(snapshot([1, 2]), snapshot([2, 3]))).toBe(true);
  });
  test('conversation switch and reload reset the baseline', () => {
    expect(hasNewTailMessages(snapshot([1]), { ...snapshot([1, 2]), selected: other })).toBe(false);
    expect(hasNewTailMessages(null, snapshot([1, 2]))).toBe(false);
    expect(hasNewTailMessages(snapshot([1, 2]), snapshot([1, 2], false))).toBe(false);
  });
  test('outbox acknowledgement and retry preserve identity while new pending input is detected', () => {
    const pendingId = Id.parse('55555555-5555-4555-8555-555555555555');
    const pending = { ...snapshot([1]), pending: [{ client_message_id: pendingId }] };
    expect(hasNewTailMessages(snapshot([1]), pending)).toBe(true);
    expect(hasNewTailMessages(pending, pending)).toBe(false);
    const confirmed = { ...snapshot([1]), syncedCursor: 2, messages: [...snapshot([1]).messages, {
      id: other, client_message_id: pendingId, sequence: 2,
    }] };
    expect(hasNewTailMessages(pending, confirmed)).toBe(false);
    expect(hasNewTailMessages(snapshot([1]), confirmed)).toBe(true);
  });
});
