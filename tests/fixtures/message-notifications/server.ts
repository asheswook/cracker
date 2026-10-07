import { join } from 'node:path';
import { z } from 'zod';
const base = process.env['NOTIFICATION_FIXTURE_BUILD'] ?? join(process.cwd(), '.omo/evidence/message-notifications/browser-build');
let content = true, gets = 0, puts = 0, holdGet = false, holdPut = false, failPut = false;
let pendingGet: (() => void) | undefined, pendingPut: (() => void) | undefined;
const state = () => ({ content, gets, puts, pendingGet: !!pendingGet, pendingPut: !!pendingPut });
const server = Bun.serve({ hostname: '127.0.0.1', port: Number(process.env['NOTIFICATION_FIXTURE_PORT'] ?? 43128),
  async fetch(request) {
    const url = new URL(request.url);
    if (url.pathname === '/fixture/state') return Response.json(state());
    if (url.pathname === '/fixture/control') {
      const { action } = z.object({ action: z.enum(['reset', 'holdGet', 'releaseGet', 'failPut', 'holdPut', 'releasePut']) }).parse(await request.json());
      switch (action) {
        case 'reset': pendingGet?.(); pendingPut?.(); pendingGet = undefined; pendingPut = undefined; content = true; gets = 0; puts = 0; holdGet = false; holdPut = false; failPut = false; break;
        case 'holdGet': holdGet = true; break;
        case 'releaseGet': pendingGet?.(); pendingGet = undefined; break;
        case 'failPut': failPut = true; break;
        case 'holdPut': holdPut = true; break;
        case 'releasePut': pendingPut?.(); pendingPut = undefined; break;
      }
      return Response.json(state());
    }
    if (url.pathname === '/v1/notifications') {
      gets++;
      const captured = content;
      if (holdGet) { holdGet = false; await new Promise<void>(resolve => { pendingGet = resolve; }); }
      return Response.json({ configured: true, enabled: false, public_key: null, show_content: captured });
    }
    if (url.pathname === '/v1/notifications/preferences') {
      puts++;
      const body = z.object({ show_content: z.boolean() }).strict().parse(await request.json());
      if (failPut) { failPut = false; return Response.json({ error: 'synthetic_failure' }, { status: 500 }); }
      if (holdPut) { holdPut = false; await new Promise<void>(resolve => { pendingPut = resolve; }); }
      content = body.show_content;
      return Response.json(body);
    }
    if (url.pathname.startsWith('/v1/')) return Response.json({ error: 'Fixture prohibits operational writes' }, { status: 403 });
    if (url.pathname === '/') {
      const native = url.searchParams.has('native') ? `<script>window.fixtureBridgeCalls=[];window.webkit={messageHandlers:{assistantNative:{postMessage:async ({method})=>{fixtureBridgeCalls.push(method);return {version:1,platform:'ios',installation_id:'77777777-7777-4777-8777-777777777777',configured:true,permission:'default',token:null};}}}};</script>` : '';
      return new Response(`<!doctype html><html lang="ko"><head><meta name="viewport" content="width=device-width, initial-scale=1"><link rel="stylesheet" href="/assets/panel.css">${native}</head><body><div id="root"></div><script type="module" src="/assets/panel.js"></script></body></html>`, { headers: { 'content-type': 'text/html' } });
    }
    if (url.pathname.startsWith('/assets/')) return new Response(Bun.file(join(base, url.pathname.slice('/assets/'.length))));
    return new Response(null, { status: 404 });
  },
});
console.log(`READY http://127.0.0.1:${server.port}/ and /?native=1`);
