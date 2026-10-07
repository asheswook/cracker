import { join } from 'node:path';
const build = process.env['TASK_STATUS_BUILD'];
if (!build) throw new TypeError('TASK_STATUS_BUILD required');
const server = Bun.serve({ hostname: '127.0.0.1', port: 0, async fetch(request) {
  const path = new URL(request.url).pathname;
  if (path === '/') return new Response('<!doctype html><html lang="ko"><meta name="viewport" content="width=device-width,initial-scale=1"><link rel="stylesheet" href="/harness.css"><div id="root"></div><script type="module" src="/harness.js"></script></html>', { headers: { 'content-type': 'text/html' } });
  if (/^\/[a-zA-Z0-9._-]+$/.test(path)) { const file = Bun.file(join(build, path.slice(1))); if (await file.exists()) return new Response(file); }
  return new Response(null, { status: 404 });
} });
console.log(`READY http://127.0.0.1:${server.port}/ PID=${process.pid}`);
