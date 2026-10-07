import { config, subscription, createViewingFixtures } from '../../notification-viewing-fixture';
import { enqueueMessageNotification } from '../../../packages/notifications/store';
import { dispatchNotifications } from '../../../packages/notifications/dispatch';

const { fixture, sql, cleanup } = createViewingFixtures();
const f = await fixture(); await f.register();
const other = crypto.randomUUID();
await f.app.request('/v1/notifications/subscription', { method: 'PUT', headers: f.headers,
  body: JSON.stringify({ installation_id: other, subscription }) });
const updates: unknown[] = [];
const server = Bun.serve({ hostname: '127.0.0.1', port: 0, async fetch(request) {
  const url = new URL(request.url);
  if (url.pathname === '/v1/notifications/viewing') {
    const body = await request.json(); updates.push(body);
    return f.app.request('/v1/notifications/viewing', { method: 'PUT', headers: f.headers, body: JSON.stringify(body) });
  }
  if (url.pathname === '/fixture/state') return Response.json({ updates });
  if (url.pathname === '/fixture/send' && request.method === 'POST') {
    const id = crypto.randomUUID();
    await sql`INSERT INTO messages(id,workspace_id,conversation_id,role,content) VALUES(${id},${f.workspace},${f.conversation},'assistant','Synthetic notification result')`;
    await enqueueMessageNotification(sql, f.workspace, { id });
    let sent = 0;
    await dispatchNotifications(sql, config, async () => { sent++; return { status: 201, retryAfter: null }; });
    const rows = await sql`SELECT s.installation_id,d.state FROM notification_deliveries d JOIN push_subscriptions s ON s.id=d.subscription_id WHERE d.intent_id=${id}`;
    return Response.json({ sent, current: rows.find(row => row['installation_id'] === f.installation)?.['state'], other: rows.find(row => row['installation_id'] === other)?.['state'], persisted: (await sql`SELECT id FROM messages WHERE id=${id}`).length === 1 });
  }
  if (url.pathname === '/fixture.js') return new Response(Bun.file('.local/foreground-notifications-fixture.js'), { headers: { 'content-type': 'text/javascript' } });
  if (url.pathname === '/away') return new Response('<h1>Another page</h1><a href="/">Return to app</a>', { headers: { 'content-type': 'text/html' } });
  return new Response(`<!doctype html><html><head><meta name="viewport" content="width=device-width,initial-scale=1"><style>body{font:16px system-ui;margin:28px;max-width:800px}button,input{font:inherit;padding:10px;margin:8px}label{display:block}</style></head><body data-conversation="${f.conversation}"><div id="root"></div><script>
localStorage.setItem('assistant.notification-installation', '${f.installation}');
let nativeActive=true;
window.addEventListener('fixture-native-active',()=>{nativeActive=!nativeActive});
if(location.search.includes('native'))window.webkit={messageHandlers:{assistantNative:{postMessage(message){return Promise.resolve(message.method==='getNotificationAttention'&&nativeActive&&!!message.conversation_id)}}}};
let subscribed=true;
window.addEventListener('fixture-toggle-subscription',()=>{subscribed=!subscribed;window.dispatchEvent(new Event('assistant-notification-subscription'))});
navigator.serviceWorker.getRegistration=async()=>({pushManager:{getSubscription:async()=>subscribed?({expirationTime:null}):null}});
</script><script type="module" src="/fixture.js"></script></body></html>`, { headers: { 'content-type': 'text/html' } });
} });
console.log(`READY http://127.0.0.1:${server.port}`);
process.on('SIGTERM', () => { server.stop(); void cleanup().then(() => process.exit(0)); });
