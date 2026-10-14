import { expect, test } from 'bun:test';
import ky from 'ky';
import type { Query } from '../services/control/db';
import { notifyUser as postNotification, notifyUserTool, proactiveActionKey } from '../services/daemon/proactive';
import { notifyUser, NotifyUserRequest } from '../services/control/repository/notify-user';

function fixture(origin: 'user' | 'schedule' | 'responsibility' = 'schedule') {
  const principal = { workspace_id: crypto.randomUUID(), vm_id: crypto.randomUUID(), role: 'vm' as const };
  const run = { id: crypto.randomUUID(), task_id: crypto.randomUUID(), vm_id: principal.vm_id, state: 'running' };
  const task = { conversation_id: crypto.randomUUID(), origin, state: 'running' };
  const request = { run_id: run.id, conversation_id: task.conversation_id, client_message_id: crypto.randomUUID(), message: 'Attention needed' };
  const message = { id: crypto.randomUUID(), task_id: run.task_id, conversation_id: task.conversation_id, role: 'assistant', content: request.message, origin, notify: true, client_message_id: request.client_message_id, sequence: 1, created_at: new Date().toISOString() };
  let saved = false;
  const calls: string[] = [];
  const sql = (async (parts: TemplateStringsArray, ...values: unknown[]) => {
    const text = parts.join('?'); calls.push(text);
    if (text === 'SELECT id FROM assistant.workspaces WHERE id=? FOR KEY SHARE') {
      expect(values).toEqual([principal.workspace_id]);
      return [{ id: principal.workspace_id }];
    }
    if (text.startsWith('SELECT daemon_session_id,daemon_reconciled FROM assistant.vms')) {
      expect(values).toEqual([principal.vm_id, principal.workspace_id]);
      expect(calls.at(-2)).toBe('SELECT id FROM assistant.workspaces WHERE id=? FOR KEY SHARE');
      return [{ daemon_session_id: null, daemon_reconciled: true }];
    }
    if (text.startsWith('SELECT * FROM assistant.runs')) {
      expect(values).toEqual([run.id, principal.workspace_id, principal.vm_id, null]);
      expect(text).toContain('daemon_session_id IS NOT DISTINCT FROM ?::uuid FOR UPDATE');
      return [run];
    }
    if (text.startsWith('SELECT conversation_id,state,origin')) return [task];
    if (text.startsWith('SELECT id FROM assistant.conversations')) return [{ id: task.conversation_id }];
    if (text.startsWith('SELECT * FROM assistant.messages')) return saved ? [message] : [];
    if (text.startsWith('INSERT INTO assistant.messages')) {
      expect(text).toContain('origin,notify)'); expect(text).toContain(',true)');
      expect(values).toEqual([principal.workspace_id, task.conversation_id, run.task_id, request.message, request.client_message_id, origin]);
      saved = true; return [message];
    }
    if (text.startsWith('INSERT INTO assistant.notification_intents')) return [{ id: message.id }];
    if (text.startsWith('INSERT INTO assistant.notification_deliveries') || text.startsWith('WITH e AS')) return [];
    throw new Error(`Unexpected SQL: ${text}`);
  }) as unknown as Query;
  return { principal, run, task, request, message, calls, sql };
}
for (const origin of ['user', 'schedule', 'responsibility'] as const) test(`notify_user inherits ${origin}, enqueues and deduplicates retries`, async () => {
  const f = fixture(origin);
  expect((await notifyUser(f.sql, f.principal, f.request)).message).toMatchObject({ origin, notify: true });
  await notifyUser(f.sql, f.principal, f.request);
  expect(f.calls.filter(text => text.startsWith('INSERT INTO assistant.messages'))).toHaveLength(1);
  expect(f.calls.filter(text => text.startsWith('INSERT INTO assistant.notification_intents'))).toHaveLength(1);
  expect(f.calls.some(text => text.startsWith('WITH e AS'))).toBe(true);
  await expect(notifyUser(f.sql, f.principal, { ...f.request, message: 'Different' })).rejects.toMatchObject({ code: 'idempotency_conflict' });
});
test('notify_user rejects client credentials, stale runs and other conversations before insert', async () => {
  const f = fixture();
  await expect(notifyUser(f.sql, { ...f.principal, role: 'client' }, f.request)).rejects.toMatchObject({ code: 'forbidden' });
  await expect(notifyUser(f.sql, f.principal, { ...f.request, conversation_id: crypto.randomUUID() })).rejects.toMatchObject({ code: 'not_found' });
  f.run.state = 'succeeded';
  await expect(notifyUser(f.sql, f.principal, f.request)).rejects.toMatchObject({ code: 'stale_run' });
  expect(f.calls.some(text => text.startsWith('INSERT'))).toBe(false);
});
test('notify_user tool posts scoped deterministic identity and validates message length', async () => {
  const scope = { runId: crypto.randomUUID(), conversationId: crypto.randomUUID(), actionId: 'run:call' };
  const bodies: unknown[] = [];
  const http = ky.create({ prefixUrl: 'https://control.test', fetch: async request => {
    const incoming = new Request(request);
    expect(new URL(incoming.url).pathname).toBe('/v1/daemon/notify-user');
    bodies.push(await incoming.json());
    return Response.json({ accepted: true });
  } });
  expect(notifyUserTool).toMatchObject({ type: 'function', name: 'notify_user' });
  for (let i = 0; i < 2; i++) await postNotification(http, scope, JSON.stringify({ message: 'Done' }), AbortSignal.timeout(1000));
  expect(bodies[0]).toEqual({ run_id: scope.runId, conversation_id: scope.conversationId, client_message_id: proactiveActionKey(scope.actionId), message: 'Done' });
  expect(bodies[1]).toEqual(bodies[0]);
  for (const message of ['', ' ', 'x'.repeat(2001)]) {
    await expect(postNotification(http, scope, JSON.stringify({ message }), AbortSignal.timeout(1000))).rejects.toThrow();
    expect(NotifyUserRequest.safeParse({ ...fixture().request, message }).success).toBe(false);
  }
  expect(NotifyUserRequest.safeParse({ ...fixture().request, message: 'x'.repeat(2000) }).success).toBe(true);
  expect(bodies).toHaveLength(2);
});
