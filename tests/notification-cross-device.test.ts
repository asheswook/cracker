import { afterAll, expect, test } from 'bun:test';
import { createNotificationFixtures, config as fcm } from './native-notifications-fixture';
import { config as web, subscription } from './notifications-fixture';
import { createWire } from './native-notifications-wire';
import { dispatchNotifications } from '../packages/notifications/dispatch';
import { hashToken } from '../services/control/auth';

const { sql, fixture, cleanup } = createNotificationFixtures({ web, fcm });
const wire = createWire();
afterAll(async () => { await wire.close(); await cleanup(); });
type Fixture = Awaited<ReturnType<typeof fixture>>;
async function viewing(f: Fixture, conversation = f.conversation, options: { active?: boolean; sequence?: number; page?: string; observed?: number } = {}) {
  return f.app.request('/v1/notifications/viewing', { method: 'PUT', headers: f.headers, body: JSON.stringify({
    installation_id: f.installation, conversation_id: conversation, page_id: options.page ?? crypto.randomUUID(),
    sequence: options.sequence ?? 1, active: options.active ?? true, observed_at: options.observed ?? Date.now(),
  }) });
}
async function register(f: Fixture) {
  expect((await f.register()).status).toBe(200);
  expect((await f.app.request('/v1/notifications/subscription', { method: 'PUT', headers: f.headers,
    body: JSON.stringify({ installation_id: crypto.randomUUID(), subscription }) })).status).toBe(200);
}
async function deliver(f: Fixture) {
  const before = wire.messages.length;
  let webSends = 0;
  await f.complete();
  await dispatchNotifications(sql, { web, fcm }, async () => { webSends++; return { status: 201, retryAfter: null }; });
  return { sent: webSends + wire.messages.length - before, states: (await f.deliveries()).map(r => r['state']).sort() };
}
test('viewing this conversation without push enrollment suppresses every other device transport', async () => {
  const f = await fixture();
  expect((await viewing(f)).status).toBe(204);
  await register(f);
  expect(await deliver(f)).toEqual({ sent: 0, states: ['suppressed', 'suppressed'] });
});
test('background release and reordered heartbeats cannot keep cross-device suppression alive', async () => {
  const f = await fixture(); await register(f); const page = crypto.randomUUID();
  await viewing(f, f.conversation, { page, sequence: 2, active: false });
  await viewing(f, f.conversation, { page, sequence: 1 });
  expect(await deliver(f)).toEqual({ sent: 2, states: ['accepted', 'accepted'] });
});
for (const observed of [-4000, 2000]) test(`stale or clock-skewed viewing (${observed}) fails open`, async () => {
  const f = await fixture(); await register(f);
  await viewing(f, f.conversation, { observed: Date.now() + observed });
  expect(await deliver(f)).toEqual({ sent: 2, states: ['accepted', 'accepted'] });
});
test('another conversation does not suppress a legitimate reply', async () => {
  const f = await fixture(); await register(f); const other = crypto.randomUUID();
  await sql`INSERT INTO conversations(id,workspace_id,title) VALUES(${other},${f.workspace},'other')`;
  await viewing(f, other);
  expect(await deliver(f)).toEqual({ sent: 2, states: ['accepted', 'accepted'] });
});
test('another workspace cannot declare this conversation viewed', async () => {
  const f = await fixture(); await register(f); const other = await fixture();
  expect((await viewing(other, f.conversation)).status).toBe(204);
  expect(await deliver(f)).toEqual({ sent: 2, states: ['accepted', 'accepted'] });
});
test('crash without release expires within the bounded lease', async () => {
  const f = await fixture(); await register(f); await viewing(f);
  const rows = await sql`SELECT extract(epoch FROM(expires_at-updated_at)) AS ttl FROM notification_conversation_viewing WHERE workspace_id=${f.workspace}`;
  expect(Number(rows[0]?.['ttl'])).toBeGreaterThan(0);
  expect(Number(rows[0]?.['ttl'])).toBeLessThanOrEqual(3.01);
  await sql`UPDATE notification_conversation_viewing SET expires_at=now()-interval '1 second' WHERE workspace_id=${f.workspace}`;
  expect(await deliver(f)).toEqual({ sent: 2, states: ['accepted', 'accepted'] });
});
test('revoked viewer credentials cannot suppress a different enrolled device', async () => {
  const f = await fixture(); await register(f);
  const token = crypto.randomUUID(), credential = await hashToken(token);
  await sql`INSERT INTO credentials(token_hash,workspace_id,role) VALUES(${credential},${f.workspace},'client')`;
  await viewing({ ...f, headers: { ...f.headers, authorization: `Bearer ${token}` } });
  await sql`UPDATE credentials SET revoked_at=now() WHERE token_hash=${credential}`;
  expect(await deliver(f)).toEqual({ sent: 2, states: ['accepted', 'accepted'] });
});
test('one hidden page cannot clear another active page on the same conversation', async () => {
  const f = await fixture(); await register(f);
  await viewing(f);
  await viewing(f, f.conversation, { active: false });
  expect(await deliver(f)).toEqual({ sent: 0, states: ['suppressed', 'suppressed'] });
});
