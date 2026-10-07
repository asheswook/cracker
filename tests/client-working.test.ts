import { expect, test } from 'bun:test';
import { MessagePage, Pending } from '../apps/web/src/types';
import { assistantWorking } from '../apps/web/src/useAssistantWorking';
import { context, conversation, message, now, other, task, working } from './client-working-fixture';

test('working eligibility uses the applied exact current input and expires at the deadline', () => {
  // Given
  const deadline = Date.parse(working.expires_at);
  // When / Then
  expect(assistantWorking(context, now)).toBe(true);
  expect(assistantWorking(context, deadline - 1)).toBe(true);
  expect(assistantWorking(context, deadline)).toBe(false);
});

const invalidContexts = [
  ['disconnected', { connected: false }], ['login', { phase: 'login' as const }],
  ['loading', { phase: 'loading' as const }], ['unselected', { selected: null }],
  ['archive', { selected: other, tasks: [{ ...task, conversation_id: other }], messages: [{ ...message, conversation_id: other }] }],
  ['missing server signal', { working: null }], ['missing task', { tasks: [] }],
  ['wrong task identity', { tasks: [{ ...task, id: other }] }],
  ['wrong task conversation', { tasks: [{ ...task, conversation_id: other }] }],
  ['unread latest input', { messages: [{ ...message, read_at: null }] }],
  ['missing latest input', { messages: [] }],
  ['wrong message conversation', { messages: [{ ...message, conversation_id: other }] }],
  ['newer read input not in snapshot', { messages: [message, { ...message, id: other, sequence: 2 }] }],
  ['newer unread input not in snapshot', { messages: [message, { ...message, id: other, sequence: 2, read_at: null }] }],
] as const;
for (const [scenario, overrides] of invalidContexts) test(`working stays false for ${scenario}`, () => {
  // Given / When
  const active = assistantWorking({ ...context, ...overrides }, now);
  // Then
  expect(active).toBe(false);
});

for (const state of ['queued', 'waiting', 'pausing', 'paused', 'cancelling', 'cancelled', 'succeeded', 'failed', 'unknown']) {
  test(`working stays false for a ${state} task`, () => {
    // Given / When
    const active = assistantWorking({ ...context, tasks: [{ ...task, state }] }, now);
    // Then
    expect(active).toBe(false);
  });
}

for (const state of ['queued', 'sending', 'failed'] as const) test(`working clears for ${state} local input`, () => {
  // Given
  const pending = Pending.parse({ client_message_id: other, conversation_id: conversation,
    content: 'new input', state, created_at: new Date(now).toISOString() });
  // When
  const active = assistantWorking({ ...context, outbox: [pending] }, now);
  // Then
  expect(active).toBe(false);
});

test('working ignores outbox entries belonging to another conversation', () => {
  // Given
  const pending = Pending.parse({ client_message_id: other, conversation_id: other,
    content: 'other input', state: 'failed', created_at: new Date(now).toISOString() });
  // When
  const active = assistantWorking({ ...context, outbox: [pending] }, now);
  // Then
  expect(active).toBe(true);
});

test('working chooses latest user by sequence rather than array order or assistant arrival', () => {
  // Given
  const messages = [{ ...message, id: other, role: 'assistant' as const, sequence: 9 }, message,
    { ...message, id: other, sequence: 0 }];
  // When
  const active = assistantWorking({ ...context, messages }, now);
  // Then
  expect(active).toBe(true);
});

test('old message pages default to absent working without fabricating activity', () => {
  // Given / When
  const page = MessagePage.parse({ messages: [message], cursor: 1 });
  // Then
  expect(page.working).toBeNull();
  expect(page.composing).toBeNull();
});
