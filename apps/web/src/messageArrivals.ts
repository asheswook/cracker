import type { Id, Message, Pending } from './types';
const noArrivals: ReadonlySet<string> = new Set();

export type MessageArrivalSnapshot = Readonly<{
  selected: Id | null;
  syncedCursor: number | null;
  messages: readonly Pick<Message, 'id' | 'client_message_id' | 'sequence'>[];
  pending: readonly Pick<Pending, 'client_message_id'>[];
}>;

export function hasNewTailMessages(
  previous: MessageArrivalSnapshot | null,
  current: MessageArrivalSnapshot,
): boolean {
  return newTailMessageKeys(previous, current).size > 0;
}

export function newTailMessageKeys(
  previous: MessageArrivalSnapshot | null,
  current: MessageArrivalSnapshot,
): ReadonlySet<string> {
  if (!previous || previous.selected !== current.selected ||
      previous.syncedCursor === null || current.syncedCursor === null) return noArrivals;
  if (previous.messages === current.messages && previous.pending === current.pending &&
      previous.syncedCursor === current.syncedCursor) return noArrivals;
  const known = new Set([
    ...previous.messages.map(message => message.client_message_id ?? message.id),
    ...previous.pending.map(message => message.client_message_id),
  ]);
  const previousCursor = previous.syncedCursor, currentCursor = current.syncedCursor;
  const arrivals = new Set([
    ...current.messages.filter(message =>
    message.sequence > previousCursor && message.sequence <= currentCursor &&
    !known.has(message.client_message_id ?? message.id)).map(message => message.client_message_id ?? message.id),
    ...current.pending.filter(message => !known.has(message.client_message_id)).map(message => message.client_message_id),
  ]);
  return arrivals.size ? arrivals : noArrivals;
}
