import { join } from 'node:path';

const build = process.env['TASK_STATUS_BUILD'];
if (!build) throw new Error('TASK_STATUS_BUILD is required');
let actionRequests = 0;
const server = Bun.serve({ hostname: '127.0.0.1', port: Number(process.env['TASK_STATUS_PORT'] ?? 0),
  async fetch(request) {
    const path = new URL(request.url).pathname;
    if (path === '/fixture/reset') { actionRequests = 0; return Response.json({ reset: true }); }
    if (path.startsWith('/v1/')) { actionRequests++; return Response.json({ unexpectedAction: true }, { status: 400 }); }
    if (path === '/fixture/state') return Response.json({ actionRequests });
    if (path === '/') return new Response('<!doctype html><html lang="ko"><head><meta name="viewport" content="width=device-width, initial-scale=1"><link rel="stylesheet" href="/harness.css"><style>main{padding:var(--s6);max-width:900px;margin:auto}nav{display:flex;flex-wrap:wrap;gap:var(--s1)}nav button{padding:var(--s2);font:inherit}#status{padding:var(--s3);margin:var(--s6) 0;background:var(--surface);border-radius:var(--r3);min-height:var(--s12)}</style></head><body><div id="root"></div><script type="module" src="/harness.js"></script></body></html>', { headers: { 'content-type': 'text/html' } });
    if (/^\/[a-zA-Z0-9._-]+$/.test(path)) { const file = Bun.file(join(build, path.slice(1))); if (await file.exists()) return new Response(file); }
    return new Response(null, { status: 404 });
  },
});
console.log(`READY http://127.0.0.1:${server.port}/ PID=${process.pid} BUILD=${build}`);
