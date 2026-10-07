import { join } from 'node:path';

const base = process.env['NATIVE_FIXTURE_BUILD_DIR'] ?? join(process.cwd(), '.local/native-resume-recovery');
const id = '11111111-1111-4111-8111-111111111111';
const conversation = { id, title: 'Synthetic conversation', created_at: '2026-10-03T00:00:00Z' };
let disconnected = false;
let statusGets = 0;
const server = Bun.serve({
  hostname: '127.0.0.1', port: Number(process.env['NATIVE_FIXTURE_PORT'] ?? 0),
  async fetch(request) {
    const url = new URL(request.url);
    const path = url.pathname;
    if (path === '/fixture/disconnect') { disconnected = url.searchParams.has('on'); return Response.json({ disconnected }); }
    if (path === '/fixture/state') return Response.json({ disconnected, statusGets });
    if (path === '/v1/session') return request.method === 'DELETE' ? Response.json({}, { status: 403 }) : Response.json({ workspace_id: id });
    if (path === '/v1/notifications') { statusGets++; return Response.json({ configured: true, enabled: false, public_key: null, show_content: true }); }
    if (path === '/v1/assistant/conversation') return Response.json({ conversation });
    if (path === '/v1/conversations') return Response.json({ conversations: [conversation] });
    if (path === '/v1/tasks') return disconnected ? Response.json({}, { status: 400 }) : Response.json({ tasks: [] });
    if (path === '/v1/vms') return Response.json({ vms: [] });
    if (path === '/v1/schedules') return Response.json({ schedules: [] });
    if (path === '/v1/memory') return Response.json({ memories: [] });
    if (path === '/v1/settings') return Response.json({ persona: { name: 'Fixture', role: 'Synthetic QA only', style: '' } });
    if (path.endsWith('/messages')) return Response.json({ messages: [], cursor: 0, receipts: [] });
    if (path.startsWith('/v1/')) return Response.json({}, { status: 404 });
    if (path === '/') {
      const html = await Bun.file(join(base, 'dist/index.html')).text();
      const bridge = await Bun.file(join(import.meta.dir, 'bridge.js')).text();
      return new Response(html.replace('<head>', `<head><script>${bridge}</script>`).replace('</body>', '<script>fixture.controls()</script></body>'), { headers: { 'content-type': 'text/html' } });
    }
    if (path === '/hook') return new Response('<html><body><div id="root"></div><script src="/bridge.js"></script><script type="module" src="/hook.js"></script></body></html>', { headers: { 'content-type': 'text/html' } });
    if (path === '/bridge.js') return new Response(Bun.file(join(import.meta.dir, 'bridge.js')));
    return new Response(Bun.file(join(base, path === '/hook.js' ? path.slice(1) : `dist${path}`)));
  },
});
console.log(`READY http://127.0.0.1:${server.port}/ (real 30 second bridge deadline)`);
