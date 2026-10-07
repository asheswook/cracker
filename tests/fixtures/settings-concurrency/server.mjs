import { createRequire } from 'node:module';
import { resolve } from 'node:path';
import { Hono } from 'hono';
import { DomainError } from '../../../packages/protocol/index.ts';
import { createDatabase } from '../../../services/control/db.ts';
import { assistantRoutes } from '../../../services/control/routes/assistant.ts';

const sql = createDatabase(process.env.TEST_DATABASE_URL ?? 'postgres://assistant:assistant@127.0.0.1:55439/assistant_dev');
const workspace = crypto.randomUUID();
const app = new Hono();
app.use('*', async (c, next) => { c.set('principal', { workspace_id: workspace, role: 'client', vm_id: null }); await next(); });
app.onError((error, c) => error instanceof DomainError
  ? c.json({ error: { code: error.code, message: error.message } }, error.status)
  : c.json({ error: { code: 'fixture_error', message: error.message } }, 500));
app.route('/v1', assistantRoutes(sql));
const require = createRequire(import.meta.url);
const { build } = createRequire(require.resolve('wrangler/package.json'))('esbuild');
const bundle = await build({
  stdin: { contents: `
    import {createRoot} from 'react-dom/client';
    import {useState,useEffect} from 'react';
    import {LazyMotion,domAnimation} from 'motion/react';
    import {InstructionsEditor} from './apps/web/src/settings/InstructionsEditor';
    import {Instructions} from './apps/web/src/settings/types';
    import {read} from './apps/web/src/api';
    import './apps/web/src/styles.css';
    import './apps/web/src/settings/persona.css';
    function Fixture(){
      const [value,setValue]=useState(null),[editing,setEditing]=useState(false);
      useEffect(()=>{void read('/v1/settings',Instructions).then(v=>{setValue(v);setEditing(true)})},[]);
      return <main><h1>Persona edit fixture</h1>{value&&<><pre data-testid="saved">{JSON.stringify(value,null,2)}</pre><button onClick={()=>setEditing(true)}>Open editor</button>{editing&&<InstructionsEditor value={value} initialPersona={null} onClose={()=>setEditing(false)} onSaved={v=>{setValue(v);setEditing(false)}}/>}</>}</main>
    }
    createRoot(document.getElementById('root')).render(<LazyMotion features={domAnimation}><Fixture/></LazyMotion>);
  `, resolveDir: process.cwd(), loader: 'tsx' },
  bundle: true, write: false, format: 'esm', platform: 'browser', jsx: 'automatic',
  nodePaths: [resolve('apps/web/node_modules')], outdir: 'out', loader: { '.woff2': 'dataurl', '.woff': 'dataurl' },
});
const js = bundle.outputFiles.find(f => f.path.endsWith('.js'))?.text;
const css = bundle.outputFiles.find(f => f.path.endsWith('.css'))?.text;
if (!js || !css) throw new TypeError('Expected editor JS and CSS');
await sql`INSERT INTO assistant.workspaces(id,name) VALUES(${workspace},'settings-concurrency-fixture')`;
const server = Bun.serve({ hostname: '127.0.0.1', port: Number(process.env.QA_PORT ?? 0), fetch: async request => {
  const url = new URL(request.url);
  if (url.pathname.startsWith('/v1/')) return app.fetch(request);
  if (url.pathname === '/bundle.js') return new Response(js, { headers: { 'Content-Type': 'text/javascript' } });
  if (url.pathname === '/bundle.css') return new Response(css, { headers: { 'Content-Type': 'text/css' } });
  return new Response('<!doctype html><html lang="ko"><meta charset="UTF-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>Persona concurrency fixture</title><link rel="stylesheet" href="/bundle.css"><div id="root"></div><script type="module" src="/bundle.js"></script></html>', { headers: { 'Content-Type': 'text/html' } });
} });
console.log(JSON.stringify({ url: server.url.href, workspace, bundleSha256: new Bun.CryptoHasher('sha256').update(js).digest('hex') }));
for (const signal of ['SIGINT', 'SIGTERM']) process.once(signal, async () => {
  await server.stop(true);
  await sql`DELETE FROM assistant.workspaces WHERE id=${workspace}`;
  await sql.end();
  process.exit(0);
});
