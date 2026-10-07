import { afterAll, expect, test } from 'bun:test';
import { config, subscription, createViewingFixtures } from './notification-viewing-fixture.ts';
import { dispatchNotifications } from '../packages/notifications/dispatch.ts';

const { cleanup, fixture, sql } = createViewingFixtures();
afterAll(cleanup);
type Fixture = Awaited<ReturnType<typeof fixture>>;
const view = (f: Fixture, page: string, sequence: number, active: boolean, observed = Date.now(), installation = f.installation) =>
  f.app.request('/v1/notifications/viewing', { method: 'PUT', headers: f.headers,
    body: JSON.stringify({ installation_id: installation, page_id: page, sequence, active, observed_at: observed }) });
async function sendAndState(f: Fixture) {
  await f.complete();
  let sent = 0;
  await dispatchNotifications(sql, config, async () => { sent++; return { status: 201, retryAfter: null }; });
  return { sent, states: (await f.deliveries()).map(row => row['state']) };
}
test('focused installation suppresses its push while another device still receives the message', async () => {
  const f = await fixture();
  expect((await f.register()).status).toBe(200);
  const other = crypto.randomUUID();
  expect((await f.app.request('/v1/notifications/subscription', { method: 'PUT', headers: f.headers,
    body: JSON.stringify({ installation_id: other, subscription }) })).status).toBe(200);
  const response = await f.app.request('/v1/notifications/viewing', { method: 'PUT', headers: f.headers,
    body: JSON.stringify({ installation_id: f.installation, page_id: crypto.randomUUID(), sequence: 1, active: true, observed_at: Date.now() }) });
  expect(response.status).toBe(204);
  await f.complete();
  let sent = 0;
  await dispatchNotifications(sql, config, async () => { sent++; return { status: 201, retryAfter: null }; });
  expect(sent).toBe(1);
  const rows = await f.deliveries();
  expect(rows.map(row => row['state']).sort()).toEqual(['accepted', 'suppressed']);
  expect((await sql`SELECT id FROM messages WHERE conversation_id=${f.conversation} AND role='assistant'`).length).toBe(1);
});

test('blur clears immediately; reordered or duplicate active requests cannot revive the page', async () => {
  const f = await fixture(); await f.register();
  const page = crypto.randomUUID();
  expect((await view(f, page, 2, false)).status).toBe(204);
  expect((await view(f, page, 1, true)).status).toBe(204);
  expect((await view(f, page, 2, true)).status).toBe(204);
  expect(await sendAndState(f)).toEqual({ sent: 1, states: ['accepted'] });
});

test('a hidden second tab cannot clear the focused tab on the same installation', async () => {
  const f = await fixture(); await f.register();
  await view(f, crypto.randomUUID(), 1, true);
  await view(f, crypto.randomUUID(), 9, false);
  expect(await sendAndState(f)).toEqual({ sent: 0, states: ['suppressed'] });
});

for (const [name, offset] of [['delayed old request', -4000], ['future clock uncertainty', 2000]] as const) {
  test(`${name} fails open`, async () => {
    const f = await fixture(); await f.register();
    await view(f, crypto.randomUUID(), 1, true, Date.now() + offset);
    expect(await sendAndState(f)).toEqual({ sent: 1, states: ['accepted'] });
  });
}

test('crashed page lease expires and sends normally without a close beacon', async () => {
  const f = await fixture(); await f.register();
  await view(f, crypto.randomUUID(), 1, true);
  const lease = await sql`SELECT extract(epoch FROM (v.expires_at-v.updated_at)) AS seconds FROM notification_viewing v JOIN push_subscriptions s ON s.id=v.subscription_id WHERE s.workspace_id=${f.workspace}`;
  expect(Number(lease[0]?.['seconds'])).toBeGreaterThan(0);
  expect(Number(lease[0]?.['seconds'])).toBeLessThanOrEqual(3.01);
  await sql`UPDATE notification_viewing SET expires_at=now()-interval '1 second' WHERE subscription_id IN(SELECT id FROM push_subscriptions WHERE workspace_id=${f.workspace})`;
  expect(await sendAndState(f)).toEqual({ sent: 1, states: ['accepted'] });
});

test('foreground on a different conversation or settings still suppresses within this workspace', async () => {
  const f = await fixture(); await f.register();
  await view(f, crypto.randomUUID(), 1, true);
  expect(await sendAndState(f)).toEqual({ sent: 0, states: ['suppressed'] });
  const intent = await sql`SELECT id FROM notification_intents WHERE workspace_id=${f.workspace}`;
  expect(intent).toHaveLength(1);
});

test('other workspace cannot set a lease on this installation; missing auth is rejected', async () => {
  const f = await fixture(); await f.register();
  const other = await fixture();
  expect((await view(other, crypto.randomUUID(), 1, true, Date.now(), f.installation)).status).toBe(204);
  expect((await f.app.request('/v1/notifications/viewing', { method: 'PUT', headers: { 'content-type': 'application/json' }, body: '{}' })).status).toBe(401);
  expect(await sendAndState(f)).toEqual({ sent: 1, states: ['accepted'] });
});

test('a different browser session for the same credential cannot set this subscription lease', async () => {
  const f = await fixture(); await f.register();
  const session = 'a'.repeat(64);
  await sql`INSERT INTO browser_sessions(token_hash,credential_hash,expires_at) VALUES(${session},${f.credential},now()+interval '1 hour')`;
  await sql`UPDATE push_subscriptions SET session_hash=${session} WHERE workspace_id=${f.workspace}`;
  await view(f, crypto.randomUUID(), 1, true);
  expect(await sendAndState(f)).toEqual({ sent: 1, states: ['accepted'] });
});

test('disabled and native installations never gain a web viewing lease', async () => {
  const f = await fixture(); await f.register();
  await sql`UPDATE push_subscriptions SET transport='fcm' WHERE workspace_id=${f.workspace}`;
  await view(f, crypto.randomUUID(), 1, true);
  await sql`UPDATE push_subscriptions SET transport='web',enabled=false WHERE workspace_id=${f.workspace}`;
  await view(f, crypto.randomUUID(), 1, true);
  expect(await sql`SELECT v.* FROM notification_viewing v JOIN push_subscriptions s ON s.id=v.subscription_id WHERE s.workspace_id=${f.workspace}`).toHaveLength(0);
});

test('invalid payloads cannot create a lease', async () => {
  const f = await fixture(); await f.register();
  expect((await view(f, crypto.randomUUID(), -1, true)).status).toBe(400);
  expect((await view(f, 'not-a-page', 1, true)).status).toBe(400);
  expect(await sendAndState(f)).toEqual({ sent: 1, states: ['accepted'] });
});
