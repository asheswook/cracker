import {createRequire} from 'node:module';
import {resolve,join} from 'node:path';
import {appendFileSync,readFileSync,writeFileSync} from 'node:fs';
import {Hono} from 'hono';
import {DomainError} from '../../../packages/protocol/index.ts';
import {createDatabase} from '../../../services/control/db.ts';
import {assistantRoutes} from '../../../services/control/routes/assistant.ts';
import {cleanupWorkspace} from './cleanup-workspace.mjs';
const out=resolve('.omo/evidence/settings-concurrency-browser'),sql=createDatabase(process.env.TEST_DATABASE_URL??'postgres://assistant:assistant@127.0.0.1:55439/assistant_dev'),workspace=crypto.randomUUID();
const app=new Hono();app.use('*',async(c,next)=>{c.set('principal',{workspace_id:workspace,role:'client',vm_id:null});await next();});
app.onError((error,c)=>error instanceof DomainError?c.json({error:{code:error.code,message:error.message}},error.status):c.json({error:{code:'fixture_error',message:error.message}},500));app.route('/v1',assistantRoutes(sql));
const require=createRequire(import.meta.url),{build}=createRequire(require.resolve('wrangler/package.json'))('esbuild');
const bundle=await build({entryPoints:[resolve('tests/fixtures/settings-concurrency/matrix-entry.tsx')],bundle:true,write:false,format:'esm',platform:'browser',jsx:'automatic',nodePaths:[resolve('apps/web/node_modules')],outdir:'out',loader:{'.woff2':'dataurl','.woff':'dataurl'}});
const js=bundle.outputFiles.find(f=>f.path.endsWith('.js'))?.text,css=bundle.outputFiles.find(f=>f.path.endsWith('.css'))?.text;if(!js||!css)throw new Error('Missing bundle');
await sql`INSERT INTO assistant.workspaces(id,name) VALUES(${workspace},'settings-browser-matrix')`;
let compareFailure=false,loseResponse=false;const events=[];
const record=value=>{const event={at:new Date().toISOString(),...value};events.push(event);appendFileSync(join(out,'requests.ndjson'),JSON.stringify(event)+'\n');};
const server=Bun.serve({hostname:'127.0.0.1',port:Number(process.env.QA_PORT??56309),async fetch(request){
 const url=new URL(request.url),path=url.pathname,json=value=>Response.json(value,{headers:{'cache-control':'no-store'}});
 if(path==='/fixture/state')return json({workspace,events,compareFailure,loseResponse});
 if(path==='/fixture/reset'){
  compareFailure=false;loseResponse=false;events.length=0;
  await sql`UPDATE assistant.workspaces SET settings_revision=gen_random_uuid(),instructions='',persona_name='Assistant',persona_role='',persona_style='',onboarding_status='pending',onboarding_updated_at=NULL WHERE id=${workspace}`;
  return json({workspace});
 }
 if(path==='/fixture/fault'){compareFailure=url.searchParams.get('compare')==='503';loseResponse=url.searchParams.get('response')==='lose';return json({compareFailure,loseResponse});}
 if(path==='/v1/settings'){
  if(request.method==='GET'&&compareFailure){record({method:'GET',status:503,fault:'compare'});return Response.json({error:{code:'fixture_unavailable'}},{status:503});}
  const body=request.method==='PUT'?await request.clone().json():null;
  const reply=await app.fetch(request);const result=await reply.clone().json();record({method:request.method,status:reply.status,body,result});
  if(request.method==='PUT'&&reply.status===200&&loseResponse){loseResponse=false;record({fault:'successful-response-truncated',committedRevision:result.revision});return new Response('{"revision":',{status:200,headers:{'content-type':'application/json'}});}
  return reply;
 }
 if(path==='/v1/session')return json({workspace_id:workspace});
 if(path==='/v1/conversations')return json({conversations:await sql`SELECT * FROM assistant.conversations WHERE workspace_id=${workspace}`});
 for(const name of ['tasks','vms','schedules'])if(path===`/v1/${name}`)return json({[name]:[]});
 if(path==='/v1/memory')return json({memories:[]});
 if(path.startsWith('/v1/conversations/')&&path.endsWith('/messages'))return json({messages:[],cursor:0,receipts:[]});
 if(path.startsWith('/v1/'))return app.fetch(request);
 if(path==='/bundle.js')return new Response(js,{headers:{'content-type':'text/javascript'}});
 if(path==='/bundle.css')return new Response(css,{headers:{'content-type':'text/css'}});
 if(path==='/favicon.ico')return new Response(null,{status:204});
 return new Response('<!doctype html><html lang="ko"><meta charset="UTF-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>Settings matrix fixture</title><link rel="stylesheet" href="/bundle.css"><style>main[data-fixture]{max-width:680px;margin:0 auto;padding:16px}main[data-fixture]>.message-feed{height:calc(100dvh - 32px);overflow:auto}output{display:block;overflow-wrap:anywhere}</style><div id="root"></div><script type="module" src="/bundle.js"></script></html>',{headers:{'content-type':'text/html; charset=utf-8'}});
}});
const sourcePaths=['apps/web/src/settings/InstructionsEditor.tsx','apps/web/src/settings/InstructionsPanel.tsx','apps/web/src/settings/SettingsConflict.tsx','apps/web/src/settings/PersonaOnboarding.tsx','apps/web/src/settings/settings-conflict.css','apps/web/src/settings/persona.css','tests/fixtures/settings-concurrency/matrix-entry.tsx','services/control/routes/assistant.ts'];
const sourceHashes=Object.fromEntries(sourcePaths.map(path=>[path,new Bun.CryptoHasher('sha256').update(readFileSync(path)).digest('hex')]));
const provenance={origin:server.url.href,workspace,pid:process.pid,bundleSha256:new Bun.CryptoHasher('sha256').update(js).digest('hex'),cssSha256:new Bun.CryptoHasher('sha256').update(css).digest('hex'),sourceHashes};writeFileSync(join(out,'fixture.json'),JSON.stringify(provenance,null,2));console.log(JSON.stringify(provenance));
for(const signal of ['SIGINT','SIGTERM'])process.once(signal,async()=>{await server.stop(true);const cleanup=await cleanupWorkspace(sql,workspace);await sql.end();console.log(JSON.stringify({cleanup:true,...cleanup}));process.exit(0);});
