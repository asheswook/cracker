import {createRequire} from 'node:module';
import {resolve,join} from 'node:path';
import {mkdirSync,appendFileSync,readFileSync,writeFileSync} from 'node:fs';
import postgres from 'postgres';
import {Hono} from 'hono';
import {DomainError} from '../../../packages/protocol/index.ts';
import {createDatabase} from '../../../services/control/db.ts';
import {assistantRoutes} from '../../../services/control/routes/assistant.ts';
import {appearanceRoutes} from '../../../services/control/routes/appearance.ts';
const phase=process.env.QA_PHASE??'red',out=resolve('.omo/evidence/persona-recovery',phase);mkdirSync(out,{recursive:true});
const database='persona_recovery_'+crypto.randomUUID().replaceAll('-',''),admin=postgres('postgres://assistant:assistant@127.0.0.1:55439/postgres',{max:1});
await admin.unsafe(`CREATE DATABASE "${database}" TEMPLATE template0`);
const databaseUrl=`postgres://assistant:assistant@127.0.0.1:55439/${database}`;
const migration=Bun.spawn(['bun','scripts/migrate.ts'],{env:{...process.env,DATABASE_URL:databaseUrl},stdout:'pipe',stderr:'pipe'});
writeFileSync(join(out,'migrations.log'),await new Response(migration.stdout).text()+await new Response(migration.stderr).text());if(await migration.exited!==0)throw new Error('Migration failed');
const sql=createDatabase(databaseUrl);let workspace=crypto.randomUUID();const workspaces=[workspace,crypto.randomUUID()];
for(const id of workspaces)await sql`INSERT INTO assistant.workspaces(id,name) VALUES(${id},'persona-recovery-fixture')`;
const app=new Hono();app.use('*',async(c,next)=>{c.set('principal',{workspace_id:workspace,role:'client',vm_id:null});await next();});
app.onError((error,c)=>error instanceof DomainError?c.json({error:{code:error.code,message:error.message}},error.status):c.json({error:{code:'fixture_error',message:error.message}},500));app.route('/v1',assistantRoutes(sql));app.route('/v1',appearanceRoutes(sql));
const require=createRequire(import.meta.url),{build}=createRequire(require.resolve('wrangler/package.json'))('esbuild');
const bundle=await build({entryPoints:[resolve('tests/fixtures/persona-recovery/entry.tsx')],bundle:true,write:false,format:'esm',platform:'browser',jsx:'automatic',nodePaths:[resolve('apps/web/node_modules')],outdir:'out',loader:{'.woff2':'dataurl','.woff':'dataurl'}});
const js=bundle.outputFiles.find(f=>f.path.endsWith('.js'))?.text,css=bundle.outputFiles.find(f=>f.path.endsWith('.css'))?.text;if(!js||!css)throw new Error('Missing bundle');
let failure=false,afterSave=false,hold=false,holdNext=false,slow=false;const pending=[],events=[];
const record=value=>{const event={at:new Date().toISOString(),...value};events.push(event);appendFileSync(join(out,'requests.ndjson'),JSON.stringify(event)+'\n');};
const server=Bun.serve({hostname:'127.0.0.1',idleTimeout:30,port:Number(process.env.QA_PORT??0),async fetch(request){
 const url=new URL(request.url),path=url.pathname,json=value=>Response.json(value,{headers:{'cache-control':'no-store'}});
 if(path==='/fixture/state')return json({workspace,database,events,pending:pending.length,failure});
 if(path==='/fixture/arm'){failure=url.searchParams.get('fault')==='initial';afterSave=url.searchParams.get('fault')==='save';slow=url.searchParams.get('fault')==='slow';hold=slow;return json({workspace});}
 if(path==='/fixture/recover'){failure=false;return json({failure});}
 if(path==='/fixture/fail'){failure=true;return json({failure});}
 if(path==='/fixture/hold-next'){holdNext=true;return json({holdNext});}
 if(path==='/fixture/hold'){hold=true;return json({hold});}
 if(path==='/fixture/release'){hold=false;slow=false;pending.splice(0).forEach(resolve=>resolve());return json({hold});}
 if(path==='/fixture/switch'){workspace=workspaces.find(id=>id!==workspace);failure=false;hold=false;return json({workspace});}
 if(path==='/fixture/reset'){
  failure=false;afterSave=false;hold=false;pending.splice(0).forEach(resolve=>resolve());events.length=0;
  await sql`UPDATE assistant.workspaces SET settings_revision=gen_random_uuid(),instructions='',persona_name='Assistant',persona_role='',persona_style='',onboarding_status='pending',onboarding_updated_at=NULL,appearance='{"version":1,"shape":"flower","color":"coral","eyes":"oval","eyewear":"monocle","accessory":"none"}'::jsonb,appearance_revision=gen_random_uuid() WHERE id IN ${sql(workspaces)}`;
  if(url.searchParams.get('returning'))await sql`UPDATE assistant.workspaces SET persona_name='Returning persona',onboarding_status='completed' WHERE id=${workspace}`;
  return json({workspace});
 }
 if(path==='/v1/settings'||path==='/v1/appearance'){
  if(request.method==='GET'&&failure){record({path,method:'GET',status:503});return Response.json({error:{code:'fixture_unavailable'}},{status:503});}
  const holdResponse=request.method==='GET'&&(hold||holdNext);if(holdNext&&request.method==='GET')holdNext=false;
  const body=request.method==='PUT'?await request.clone().json():null;
  const reply=await app.fetch(request);const result=await reply.clone().json();
  if(holdResponse&&slow)await new Promise(resolve=>pending.push(resolve));
  else if(holdResponse){record({path,workspace,method:request.method,status:reply.status,held:true});return new Response(new ReadableStream({async start(controller){controller.enqueue(new TextEncoder().encode(' '));await new Promise(resolve=>pending.push(resolve));controller.enqueue(new TextEncoder().encode(JSON.stringify(result)));controller.close();record({path,workspace,method:request.method,status:reply.status,body,result,released:true});}}),{status:reply.status,headers:{'content-type':'application/json','cache-control':'no-store'}});}
  record({path,workspace,method:request.method,status:reply.status,body,result});
  if(request.method==='PUT'&&reply.status===200&&afterSave){failure=true;afterSave=false;}
  return reply;
 }
 if(path==='/v1/session')return json({workspace_id:workspace});
 if(path==='/v1/tasks')return Response.json({error:{code:'fixture_polling_unavailable'}},{status:400});
 if(path==='/v1/conversations')return json({conversations:await sql`SELECT * FROM assistant.conversations WHERE workspace_id=${workspace}`});
 for(const name of ['vms','schedules'])if(path===`/v1/${name}`)return json({[name]:[]});
 if(path==='/v1/memory')return json({memories:[]});
 if(path.startsWith('/v1/conversations/')&&path.endsWith('/messages'))return json({messages:[],cursor:0,receipts:[]});
 if(path.startsWith('/v1/'))return app.fetch(request);
 if(path==='/bundle.js')return new Response(js,{headers:{'content-type':'text/javascript'}});
 if(path==='/bundle.css')return new Response(css,{headers:{'content-type':'text/css'}});
 if(path==='/favicon.ico')return new Response(null,{status:204});
 return new Response('<!doctype html><html lang="ko"><meta charset="UTF-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>Persona recovery fixture</title><link rel="stylesheet" href="/bundle.css"><style>main[data-fixture]{max-width:680px;margin:0 auto;padding:16px}nav{display:flex;flex-wrap:wrap;gap:8px;margin:8px}nav button{min-height:44px}.message-feed{max-height:75dvh;overflow:auto}</style><div id="root"></div><script type="module" src="/bundle.js"></script></html>',{headers:{'content-type':'text/html; charset=utf-8'}});
}});
const paths=['apps/web/src/settings/PersonaOnboarding.tsx','apps/web/src/settings/InstructionsPanel.tsx','apps/web/src/appearance/AppearancePanel.tsx','apps/web/src/store.ts','tests/fixtures/persona-recovery/entry.tsx','tests/fixtures/persona-recovery/server.mjs'];
const provenance={origin:server.url.href,workspace,database,pid:process.pid,bundleSha256:new Bun.CryptoHasher('sha256').update(js).digest('hex'),sourceHashes:Object.fromEntries(paths.map(path=>[path,new Bun.CryptoHasher('sha256').update(readFileSync(path)).digest('hex')]))};writeFileSync(join(out,'fixture.json'),JSON.stringify(provenance,null,2));console.log(JSON.stringify(provenance));
for(const signal of ['SIGINT','SIGTERM'])process.once(signal,async()=>{pending.splice(0).forEach(resolve=>resolve());await server.stop(true);await sql.end();await admin.unsafe(`DROP DATABASE "${database}" WITH (FORCE)`);await admin.end();writeFileSync(join(out,'cleanup.json'),JSON.stringify({database,dropped:true}));process.exit(0);});
