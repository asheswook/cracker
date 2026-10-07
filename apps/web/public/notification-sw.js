self.addEventListener('install', event => event.waitUntil(self.skipWaiting()));
self.addEventListener('activate', event => event.waitUntil(self.clients.claim()));
self.addEventListener('push', event => {
  let data = {};
  try { const value = event.data?.json(); if (value && typeof value === 'object' && !Array.isArray(value)) data = value; } catch (error) { if (!(error instanceof SyntaxError)) throw error; }
  const id = typeof data.id === 'string' && /^[0-9a-f-]{36}$/i.test(data.id) ? data.id : 'assistant-result';
  const target = resultUrl(data.url);
  event.waitUntil(self.registration.showNotification(
    notificationText(data.title, 'Assistant', 80),
    { body: notificationText(data.body, '새 메시지', 2400), tag: id, renotify: false, data: { url: target } },
  ));
});
function notificationText(value, fallback, limit) {
  return typeof value === 'string' && value.trim() ? Array.from(value).slice(0, limit).join('') : fallback;
}
function resultUrl(value) {
  try {
    const url = new URL(typeof value === 'string' ? value : '/', self.location.origin);
    if (url.origin !== self.location.origin || url.pathname !== '/') return '/';
    for (const [key, id] of url.searchParams) if (!['conversation', 'message'].includes(key) || !/^[0-9a-f-]{36}$/i.test(id)) return '/';
    return url.pathname + url.search;
  } catch (error) { if (error instanceof TypeError) return '/'; throw error; }
}
self.addEventListener('notificationclick', event => {
  const relativeUrl = resultUrl(event.notification.data?.url);
  const url = new URL(relativeUrl, self.location.origin).href;
  event.notification.close();
  event.waitUntil((async () => {
    const windows = await self.clients.matchAll({ type: 'window', includeUncontrolled: true });
    const existing = windows.find(client => { const target = new URL(client.url); return target.origin === self.location.origin && target.pathname === '/'; });
    if (existing) { await existing.focus(); existing.postMessage({ type: 'assistant-result', url: relativeUrl }); }
    else await self.clients.openWindow(url);
  })());
});
