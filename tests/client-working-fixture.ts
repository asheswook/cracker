import { AssistantWorking, Id, Message, Task } from '../apps/web/src/types';

export const conversation = Id.parse('11111111-1111-4111-8111-111111111111');
export const other = Id.parse('22222222-2222-4222-8222-222222222222');
export const now = Date.parse('2026-10-03T00:00:00Z');
export const task = Task.parse({ id: '33333333-3333-4333-8333-333333333333', conversation_id: conversation,
  objective: 'Fixture', state: 'running', reason: null, created_at: new Date(now).toISOString(), updated_at: new Date(now).toISOString() });
export const message = Message.parse({ id: '44444444-4444-4444-8444-444444444444', conversation_id: conversation,
  role: 'user', content: 'Synthetic input', sequence: 1, created_at: new Date(now).toISOString(),
  client_message_id: null, read_at: new Date(now).toISOString() });
export const working = AssistantWorking.parse({ task_id: task.id, run_id: '55555555-5555-4555-8555-555555555555',
  input_message_id: message.id, expires_at: new Date(now + 5000).toISOString() });
export const context = { phase: 'ready' as const, connected: true, selected: conversation, assistantId: conversation,
  working, tasks: [task], messages: [message], outbox: [] };
