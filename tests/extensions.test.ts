import {afterAll,beforeAll,test,expect} from "bun:test";
import {z} from "zod";
import ky from "ky";
import {resolve} from "node:path";
import {createDatabase} from "../services/control/db.ts";
import {createApp} from "../services/control/app.ts";
import {hashToken} from "../services/control/auth.ts";
import {Server,Skill,Manifest} from "../packages/extensions/schema.ts";
import {ExtensionManager} from "../services/daemon/extensions.ts";
import {ToolExecutor} from "../services/daemon/tools.ts";
const sql=createDatabase(process.env["TEST_DATABASE_URL"]??"postgres://assistant:assistant@127.0.0.1:55439/assistant_dev");
const workspace=crypto.randomUUID(),vm=crypto.randomUUID(),other=crypto.randomUUID(),client=crypto.randomUUID()+crypto.randomUUID(),machine=crypto.randomUUID()+crypto.randomUUID(),otherMachine=crypto.randomUUID()+crypto.randomUUID();
const key=Buffer.alloc(32,7).toString("base64"),app=createApp(sql,{extensionKey:key});
const server=Bun.serve({port:0,fetch:app.fetch});
const http=ky.create({prefixUrl:server.url.href,headers:{Authorization:`Bearer ${machine}`},retry:0});
const post=(path:string,body:unknown,token=client)=>app.request(path,{method:"POST",headers:{Authorization:`Bearer ${token}`,"Content-Type":"application/json"},body:JSON.stringify(body)});
const get=(path:string,token=client)=>app.request(path,{headers:{Authorization:`Bearer ${token}`}});
beforeAll(async()=>{
 await sql`INSERT INTO assistant.workspaces(id,name) VALUES(${workspace},'extensions-test')`;
 await sql`INSERT INTO assistant.vms(id,workspace_id,name) VALUES(${vm},${workspace},'vm'),(${other},${workspace},'other')`;
 await sql`INSERT INTO assistant.credentials(token_hash,workspace_id,role,vm_id) VALUES(${await hashToken(client)},${workspace},'client',NULL),(${await hashToken(machine)},${workspace},'vm',${vm}),(${await hashToken(otherMachine)},${workspace},'vm',${other})`;
});
afterAll(async()=>{await sql`UPDATE assistant.credentials SET revoked_at=now() WHERE workspace_id=${workspace}`;await server.stop(true);await sql.end();});
const config={transport:"stdio" as const,command:process.execPath,args:[resolve("tests/mcp-extension-fixture.ts")]};
async function saveServer(extra:Record<string,unknown>={}){const response=await post('/v1/extensions/servers',{vm_id:vm,name:'fixture',enabled:true,config,...extra});if(response.status!==201)throw new TypeError(`save server ${response.status}`);return z.object({server:Server}).parse(await response.json()).server;}
test('server categories persist, reach manifests, preserve omission and clear explicitly',async()=>{
 const saved=await saveServer({category:'web'});
 try{
  expect(saved.category).toBe('web');
  expect((await sql`SELECT category FROM assistant.extension_servers WHERE id=${saved.id}`)[0]?.['category']).toBe('web');
  const listed=z.object({servers:z.array(Server)}).parse(await(await get(`/v1/extensions?vm_id=${vm}`)).json());
  expect(listed.servers.find(server=>server.id===saved.id)?.category).toBe('web');
  const manifest=Manifest.parse(await(await get('/v1/daemon/extensions',machine)).json());
  expect(manifest.servers.find(server=>server.id===saved.id)?.category).toBe('web');
  expect((await saveServer({id:saved.id})).category).toBe('web');
  expect((await saveServer({id:saved.id,category:'memory'})).category).toBe('memory');
  expect((await saveServer({id:saved.id,category:null})).category).toBeNull();
  const {category,...legacy}=saved;
  expect(Server.parse(legacy).category).toBeNull();
  expect(Manifest.parse({skills:[],servers:[{...legacy,secrets:{}}]}).servers[0]?.category).toBeNull();
 }finally{await sql`DELETE FROM assistant.extension_servers WHERE id=${saved.id}`;}
});
test('MCP secrets encrypt at rest and are write-only with preserve/replace/clear semantics',async()=>{
 // Given
 const secret='synthetic-extension-secret-731',saved=await saveServer({secrets:{FIXTURE_SECRET:secret}});
 // When
 const edited=await saveServer({id:saved.id,name:'renamed'});
 const manifest=Manifest.parse(await(await get('/v1/daemon/extensions',machine)).json());
 const raw=z.object({secret_cipher:z.string()}).parse((await sql`SELECT secret_cipher FROM assistant.extension_servers WHERE id=${saved.id}`)[0]);
 // Then
 expect(JSON.stringify(edited)).not.toContain(secret);expect(raw.secret_cipher).not.toContain(secret);
 expect(manifest.servers.find(s=>s.id===saved.id)?.secrets).toEqual({FIXTURE_SECRET:secret});
 const cleared=await saveServer({id:saved.id,secrets:{}});
 expect(cleared.secret_keys).toEqual([]);
 expect(z.object({secret_cipher:z.null()}).parse((await sql`SELECT secret_cipher FROM assistant.extension_servers WHERE id=${saved.id}`)[0]).secret_cipher).toBeNull();
 await app.request(`/v1/extensions/servers/${saved.id}`,{method:'DELETE',headers:{Authorization:`Bearer ${client}`}});
});
test('daemon manifest and skill body isolate VM ownership',async()=>{
 // Given
 const skill=z.object({skill:Skill}).parse(await(await post('/v1/extensions/skills',{vm_id:vm,name:'private skill',description:'metadata only',content:'SKILL_PRIVATE_BODY_731',enabled:true})).json()).skill;
 // When
 const owner=Manifest.parse(await(await get('/v1/daemon/extensions',machine)).json()),foreign=Manifest.parse(await(await get('/v1/daemon/extensions',otherMachine)).json());
 const read=await get(`/v1/daemon/extensions/skills/${skill.id}`,otherMachine);
 // Then
 expect(JSON.stringify(owner)).not.toContain('SKILL_PRIVATE_BODY_731');expect(owner.skills.some(s=>s.id===skill.id)).toBe(true);expect(foreign.skills).toEqual([]);expect(read.status).toBe(404);
});
test('saved configuration stays pending until matching VM applied revision',async()=>{
 // Given
 const saved=await saveServer();
 // When
 const stale=await post('/v1/daemon/extensions/observed',{kind:'server',id:saved.id,revision:saved.revision+1,state:'connected',tool_count:1,error_code:null},machine);
 const foreign=await post('/v1/daemon/extensions/observed',{kind:'server',id:saved.id,revision:saved.revision,state:'connected',tool_count:1,error_code:null},otherMachine);
 const applied=await post('/v1/daemon/extensions/observed',{kind:'server',id:saved.id,revision:saved.revision,state:'connected',tool_count:1,error_code:null},machine);
 // Then
 expect(saved.state).toBe('pending');expect(saved.observed_revision).toBeNull();expect(stale.status).toBe(409);expect(foreign.status).toBe(409);expect(applied.status).toBe(200);
 await app.request(`/v1/extensions/servers/${saved.id}`,{method:'DELETE',headers:{Authorization:`Bearer ${client}`}});
});
test('actual managed stdio MCP runs, redacts secrets, isolates failed sibling and disables effective tools',async()=>{
 // Given
 const secret=crypto.randomUUID(),saved=await saveServer({category:'web',secrets:{FIXTURE_SECRET:secret}}),bad=await saveServer({name:'bad fixture',config:{transport:'stdio',command:'/nonexistent-extension-fixture-731',args:[]}});
 const tools=new ToolExecutor(),manager=new ExtensionManager(http,tools);
 try{
  // When
  await manager.reconcile(true);
  const tool=tools.definitions.find(t=>t.type==='function'&&t.name.includes('fixture_echo'));
  if(tool?.type!=='function')throw new TypeError('actual MCP tool missing');
  expect(tools.toolCategory(tool.name)).toBe('web');
  await tools.refreshAll();
  expect(tools.toolCategory(tool.name)).toBe('web');
  const result=await tools.run(tool.name,JSON.stringify({value:'actual-mcp-value-731'}),AbortSignal.timeout(5000));
  const listed=z.object({servers:z.array(Server)}).parse(await(await get(`/v1/extensions?vm_id=${vm}`)).json());
  // Then
  expect(tool.name.length).toBeLessThanOrEqual(64);expect(result.text).toContain('actual-mcp-value-731');expect(result.text).not.toContain(secret);expect(result.text).toContain('[REDACTED]');
  expect(listed.servers.find(s=>s.id===saved.id)?.state).toBe('connected');expect(listed.servers.find(s=>s.id===bad.id)?.state).toBe('error');
  expect(listed.servers.find(s=>s.id===bad.id)?.error_code).toBe('command_not_found');
  await saveServer({id:saved.id,enabled:false});await manager.reconcile(true);
  expect(tools.definitions.some(t=>t.type==='function'&&t.name===tool.name)).toBe(false);
  expect(tools.toolCategory(tool.name)).toBeNull();
 }finally{await tools.close();await sql`DELETE FROM assistant.extension_servers WHERE id IN (${saved.id},${bad.id})`;}
});
test('skill instructions load progressively only while enabled',async()=>{
 // Given
 const skill=z.object({skill:Skill}).parse(await(await post('/v1/extensions/skills',{vm_id:vm,name:'progressive',description:'short catalog',content:'FULL_SKILL_BODY_983',enabled:true})).json()).skill;
 const tools=new ToolExecutor(),manager=new ExtensionManager(http,tools);
 try{
  // When
  await manager.reconcile(true);const body=await manager.load(JSON.stringify({skill_id:skill.id}),AbortSignal.timeout(5000));
  // Then
  expect(JSON.stringify(manager.catalog())).not.toContain('FULL_SKILL_BODY_983');expect(body).toContain('FULL_SKILL_BODY_983');
  await post('/v1/extensions/skills',{id:skill.id,expected_revision:skill.revision,vm_id:vm,name:skill.name,description:skill.description,content:skill.content,enabled:false});await manager.reconcile(true);
  expect(JSON.parse(await manager.load(JSON.stringify({skill_id:skill.id}),AbortSignal.timeout(5000)))).toEqual({error:'skill_not_enabled'});
 }finally{await tools.close();}
});
test('missing encryption key rejects secret storage instead of plaintext fallback',async()=>{
 // Given
 const unavailable=createApp(sql);
 // When
 const response=await unavailable.request('/v1/extensions/servers',{method:'POST',headers:{Authorization:`Bearer ${client}`,'Content-Type':'application/json'},body:JSON.stringify({vm_id:vm,name:'secret fixture',config,enabled:true,secrets:{TOKEN:'synthetic-secret'}})});
 // Then
 expect(response.status).toBe(503);
});
test('MCP reconnects after desired edit and daemon manager restart',async()=>{
 // Given
 const saved=await saveServer({config:{transport:'stdio',command:'/nonexistent-extension-retry-731',args:[]}}),tools=new ToolExecutor(),manager=new ExtensionManager(http,tools);
 try{
  await manager.reconcile(true);
  // When
  await saveServer({id:saved.id,config});await manager.reconcile(true);
  const first=tools.definitions.find(t=>t.type==='function'&&t.name.includes('fixture_echo'));
  if(first?.type!=='function')throw new TypeError('Reconnect failed');
  const firstResult=await tools.run(first.name,JSON.stringify({value:'before restart'}),AbortSignal.timeout(5000));
  await tools.close();const restarted=new ExtensionManager(http,tools);await restarted.reconcile(true);
  const secondResult=await tools.run(first.name,JSON.stringify({value:'after restart'}),AbortSignal.timeout(5000));
  // Then
  expect(firstResult.text).toContain('before restart');expect(secondResult.text).toContain('after restart');
 }finally{await tools.close();await sql`DELETE FROM assistant.extension_servers WHERE id=${saved.id}`;}
});
test('foreign workspace cannot list, mutate, or delete another workspace extension',async()=>{
 // Given
 const foreignWorkspace=crypto.randomUUID(),foreignToken=crypto.randomUUID()+crypto.randomUUID(),saved=await saveServer();
 await sql`INSERT INTO assistant.workspaces(id,name) VALUES(${foreignWorkspace},'foreign-extension-fixture')`;
 await sql`INSERT INTO assistant.credentials(token_hash,workspace_id,role,vm_id) VALUES(${await hashToken(foreignToken)},${foreignWorkspace},'client',NULL)`;
 try{
  // When
  const listed=await(await get(`/v1/extensions?vm_id=${vm}`,foreignToken)).json();
  const edited=await post('/v1/extensions/servers',{id:saved.id,vm_id:vm,name:'attacker',enabled:true,config},foreignToken);
  const removed=await app.request(`/v1/extensions/servers/${saved.id}`,{method:'DELETE',headers:{Authorization:`Bearer ${foreignToken}`}});
  // Then
  expect(listed).toEqual({skills:[],servers:[]});expect(edited.status).toBe(404);expect(removed.status).toBe(404);
 }finally{await sql`UPDATE assistant.credentials SET revoked_at=now() WHERE workspace_id=${foreignWorkspace}`;await sql`DELETE FROM assistant.extension_servers WHERE id=${saved.id}`;}
});

test('HTTP URL query and userinfo roundtrip while encrypted at rest, header secrets stay independent',async()=>{
 const url='https://url-user:url-password@example.com/mcp?token=url-query-proof&mode=fast#section';
 const saved=await saveServer({config:{transport:'http',url},secrets:{Authorization:'Bearer header-proof'}});
 try{
  expect(saved.config).toEqual({transport:'http',url});
  const raw=(await sql`SELECT config,secret_cipher,secret_keys FROM assistant.extension_servers WHERE id=${saved.id}`)[0];
  expect(JSON.stringify(raw)).not.toContain('url-password');expect(JSON.stringify(raw)).not.toContain('url-query-proof');expect(JSON.stringify(raw)).not.toContain('header-proof');
  const listed=z.object({servers:z.array(Server)}).parse(await(await get(`/v1/extensions?vm_id=${vm}`)).json());
  expect(listed.servers.find(s=>s.id===saved.id)?.config).toEqual({transport:'http',url});
  expect(JSON.stringify(listed)).not.toContain('header-proof');
  const edited=await saveServer({id:saved.id,config:{transport:'http',url},name:'URL renamed'});
  expect(edited.config).toEqual({transport:'http',url});expect(edited.secret_keys).toEqual(['Authorization']);
  let manifest=Manifest.parse(await(await get('/v1/daemon/extensions',machine)).json());
  expect(manifest.servers.find(s=>s.id===saved.id)?.config).toEqual({transport:'http',url});
  expect(manifest.servers.find(s=>s.id===saved.id)?.secrets).toEqual({Authorization:'Bearer header-proof'});
  const cleared=await saveServer({id:saved.id,config:{transport:'http',url},secrets:{}});
  expect(cleared.secret_keys).toEqual([]);expect(cleared.config).toEqual({transport:'http',url});
  manifest=Manifest.parse(await(await get('/v1/daemon/extensions',machine)).json());
  expect(manifest.servers.find(s=>s.id===saved.id)?.secrets).toEqual({});
  const replacement='https://example.com/mcp?token=replaced-proof';
  expect((await saveServer({id:saved.id,config:{transport:'http',url:replacement}})).config).toEqual({transport:'http',url:replacement});
  const retry=await post(`/v1/extensions/servers/${saved.id}/retry`,{});
  expect(z.object({server:Server}).parse(await retry.json()).server.config).toEqual({transport:'http',url:replacement});
  const plain='https://example.com/mcp';await saveServer({id:saved.id,config:{transport:'http',url:plain}});
  expect(z.object({secret_cipher:z.null()}).parse((await sql`SELECT secret_cipher FROM assistant.extension_servers WHERE id=${saved.id}`)[0]).secret_cipher).toBeNull();
 }finally{await app.request(`/v1/extensions/servers/${saved.id}`,{method:'DELETE',headers:{Authorization:`Bearer ${client}`}})}
});

test('saved URL reaches actual managed HTTP MCP with authentication and query',async()=>{
 const {McpServer}=await import('@modelcontextprotocol/sdk/server/mcp.js');
 const {WebStandardStreamableHTTPServerTransport}=await import('@modelcontextprotocol/sdk/server/webStandardStreamableHttp.js');
 const mcp=new McpServer({name:'managed URL',version:'1'});
 mcp.registerTool('url_proof',{inputSchema:{}},async()=>({content:[{type:'text',text:'managed URL transport verified'}]}));
 const transport=new WebStandardStreamableHTTPServerTransport({sessionIdGenerator:()=>crypto.randomUUID(),enableJsonResponse:true});await mcp.connect(transport);
 const authorization=`Basic ${Buffer.from('managed-user:managed-pass').toString('base64')}`;
 const endpoint=Bun.serve({port:0,fetch:request=>request.headers.get('authorization')===authorization&&new URL(request.url).searchParams.get('key')==='managed-query'?transport.handleRequest(request):new Response('unauthorized',{status:401})});
 const url=new URL('/mcp',endpoint.url);url.username='managed-user';url.password='managed-pass';url.searchParams.set('key','managed-query');
 const saved=await saveServer({config:{transport:'http',url:url.href}}),tools=new ToolExecutor(),manager=new ExtensionManager(http,tools);
 try{await manager.reconcile(true);const tool=tools.definitions.find(t=>t.type==='function'&&t.name.includes('url_proof'));if(!tool||tool.type!=='function')throw new TypeError('managed URL tool absent');
  expect((await tools.run(tool.name,'{}',AbortSignal.timeout(5000))).text).toContain('managed URL transport verified');
  const listed=z.object({servers:z.array(Server)}).parse(await(await get(`/v1/extensions?vm_id=${vm}`)).json());expect(listed.servers.find(s=>s.id===saved.id)?.state).toBe('connected');
 }finally{await tools.close();await mcp.close();await endpoint.stop(true);await sql`DELETE FROM assistant.extension_servers WHERE id=${saved.id}`}
});

test('MCP connection failures preserve a safe actionable cause through retry backoff',async()=>{
 const secret='query-failure-private-918',endpoint=Bun.serve({port:0,fetch:()=>new Response('rejected '+secret,{status:401})});
 const saved=await saveServer({config:{transport:'http',url:new URL('/mcp?token='+secret,endpoint.url).href}});
 const tools=new ToolExecutor(),manager=new ExtensionManager(http,tools);
 try{
  await manager.reconcile(true);
  let observed=(await sql`SELECT error_code,state FROM assistant.extension_servers WHERE id=${saved.id}`)[0];
  expect(observed?.['error_code']).toBe('authentication_failed');
  expect(JSON.stringify(observed)).not.toContain(secret);
  await manager.reconcile(true);
  observed=(await sql`SELECT error_code,state FROM assistant.extension_servers WHERE id=${saved.id}`)[0];
  expect(observed?.['error_code']).toBe('authentication_failed');
 }finally{await tools.close();await endpoint.stop(true);await sql`DELETE FROM assistant.extension_servers WHERE id=${saved.id}`;}
});
test('a switched-off MCP tool is listed in settings but never offered to the model',async()=>{
 // Given
 const saved=await saveServer();
 const tools=new ToolExecutor(),manager=new ExtensionManager(http,tools);
 try{
  await manager.reconcile(true);
  const offered=z.object({servers:z.array(Server)}).parse(await(await get(`/v1/extensions?vm_id=${vm}`)).json()).servers.find(s=>s.id===saved.id);
  const echo=offered?.tools.find(t=>t.name==='fixture_echo');
  expect(echo).toBeDefined();
  expect(tools.definitions.some(t=>t.type==='function'&&t.name.includes('fixture_echo'))).toBe(true);
  // When
  const updated=await saveServer({id:saved.id,disabled_tools:['fixture_echo']});
  await manager.reconcile(true);
  // Then
  expect(updated.disabled_tools).toEqual(['fixture_echo']);
  expect(tools.definitions.some(t=>t.type==='function'&&t.name.includes('fixture_echo'))).toBe(false);
  const listed=z.object({servers:z.array(Server)}).parse(await(await get(`/v1/extensions?vm_id=${vm}`)).json()).servers.find(s=>s.id===saved.id);
  expect(listed?.tools.some(t=>t.name==='fixture_echo')).toBe(true);
  expect(listed?.disabled_tools).toEqual(['fixture_echo']);
  // And turning it back on restores it; omitting the field keeps the choice.
  await saveServer({id:saved.id,name:'fixture renamed'});await manager.reconcile(true);
  expect(tools.definitions.some(t=>t.type==='function'&&t.name.includes('fixture_echo'))).toBe(false);
  await saveServer({id:saved.id,disabled_tools:[]});await manager.reconcile(true);
  expect(tools.definitions.some(t=>t.type==='function'&&t.name.includes('fixture_echo'))).toBe(true);
 }finally{await tools.close();await sql`DELETE FROM assistant.extension_servers WHERE id=${saved.id}`;}
});
