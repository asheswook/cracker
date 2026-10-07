import {test,expect} from 'bun:test';
import {mkdtemp,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {WebSocketServer,type WebSocket} from 'ws';
import OpenAI from 'openai';
import {z} from 'zod';
import {ResponseSocketPool} from '../packages/provider/websocket.ts';
import {OpenAIProvider} from '../packages/provider/index.ts';
import {atomicSecret} from '../packages/provider/credentials.ts';
const Request=z.object({input:z.unknown(),stream_id:z.string().optional(),max_output_tokens:z.number().optional(),previous_response_id:z.string().optional(),service_tier:z.string(),store:z.boolean()});
type Request=z.infer<typeof Request>;
function harness(handler:(socket:WebSocket,request:Request,id:number)=>void){
 const requests:Array<{body:Request;connection:number}>=[],auth:string[]=[];let connections=0;
 const server=new WebSocketServer({port:0});const address=server.address();if(!address||typeof address==='string')throw new TypeError('fixture address');
 server.on('connection',(socket,upgrade)=>{const id=++connections;auth.push(upgrade.headers.authorization??'');socket.on('message',raw=>{const body=Request.parse(JSON.parse(String(raw)));requests.push({body,connection:id});handler(socket,body,id);});});
 return {requests,auth,url:`http://127.0.0.1:${address.port}`,close(){for(const socket of server.clients)socket.terminate();server.close();}};
}
function begin(socket:WebSocket,id:string,item:string){socket.send(JSON.stringify({type:'response.created',response:{id,status:'in_progress',output:[]}}));socket.send(JSON.stringify({type:'response.output_item.added',output_index:0,item:{id:item,type:'message',status:'in_progress',role:'assistant',content:[]}}));}
function finish(socket:WebSocket,id:string,item:string,text:string){socket.send(JSON.stringify({type:'response.output_item.done',output_index:0,item:{id:item,type:'message',status:'completed',phase:'final_answer',role:'assistant',content:[{type:'output_text',text,annotations:[]}]}}));socket.send(JSON.stringify({type:'response.completed',response:{id,status:'completed',service_tier:'default',output:[]}}));}
const body=(text:string)=>({model:'gpt-6-astra',input:[{role:'user' as const,content:text}],stream:true as const,store:false,parallel_tool_calls:false});
test('implicit reuse excludes prior response/items from empty-terminal fallback and preserves fullinput',async()=>{
 let count=0;const h=harness((socket)=>{count++;if(count>1){begin(socket,'response1','item1');finish(socket,'response1','item1','STALE');}begin(socket,`response${count}`,`item${count}`);finish(socket,`response${count}`,`item${count}`,`answer${count}`);});
 const pool=new ResponseSocketPool(new OpenAI({apiKey:'fixture',baseURL:h.url}),{lane:'implicit'});
 try{expect((await pool.respond(body('first-history'),AbortSignal.timeout(1000))).output_text).toBe('answer1');expect((await pool.respond(body('pruned-history'),AbortSignal.timeout(1000))).output_text).toBe('answer2');expect(h.requests.map(r=>r.connection)).toEqual([1,1]);expect(h.requests[1]?.body.input).toEqual(body('pruned-history').input);expect(h.requests.every(r=>r.body.stream_id===undefined&&r.body.previous_response_id===undefined&&r.body.service_tier==='default')).toBe(true);}
 finally{pool.close();h.close();}
});
test('implicit output fallback rejects unknown item IDs even with correct terminal response ID',async()=>{
 const h=harness(socket=>{begin(socket,'response','known');finish(socket,'response','unknown','wrong');}),pool=new ResponseSocketPool(new OpenAI({apiKey:'fixture',baseURL:h.url}),{lane:'implicit'});
 try{await expect(pool.respond(body('test'),AbortSignal.timeout(1000))).rejects.toThrow('item identity');expect(h.requests).toHaveLength(1);}
 finally{pool.close();h.close();}
});
test('implicit concurrent calls and abort remain isolated',async()=>{
 const started=Promise.withResolvers<void>();const h=harness((socket,request,id)=>{begin(socket,`response${id}`,`item${id}`);if(JSON.stringify(request.input).includes('main'))started.resolve();else finish(socket,`response${id}`,`item${id}`,'memory');});
 const pool=new ResponseSocketPool(new OpenAI({apiKey:'fixture',baseURL:h.url}),{lane:'implicit'}),abort=new AbortController();
 try{const main=pool.respond(body('main'),abort.signal);await started.promise;const memory=pool.respond(body('memory'),AbortSignal.timeout(1000));abort.abort();await expect(main).rejects.toThrow();expect((await memory).output_text).toBe('memory');expect(h.requests[0]?.connection).not.toBe(h.requests[1]?.connection);}
 finally{pool.close();h.close();}
});
test('credential rotation retires idle old generation without cancelling its active response',async()=>{
 const pending=Promise.withResolvers<()=>void>();let calls=0;
 const h=harness((socket,_request,connection)=>{const id=`response${++calls}`,item=`item${calls}`;begin(socket,id,item);if(connection===1)pending.resolve(()=>finish(socket,id,item,'old-finished'));else finish(socket,id,item,'new-finished');});
 const dir=await mkdtemp(join(tmpdir(),'oauth-ws-')),file=join(dir,'credential.json'),previous=process.env['OPENAI_BASE_URL'];process.env['OPENAI_BASE_URL']=h.url;
 const credential={issuer:'https://auth.openai.com' as const,subject:'subject',client_id:'client',ext_agent_host_id:'host',id_token:'fixture',access_token:'old-fixture',refresh_token:'fixture',expires_at:Date.now()+3600000,scopes:['chatgpt.tokens.use.direct']};
 await atomicSecret(file,credential);const provider=new OpenAIProvider({mode:'chatgpt',model:'gpt-6-astra',transport:'websocket',tokenFile:file});
 try{
  const old=provider.respond([{role:'user',content:'old'}],[],AbortSignal.timeout(2000));const completeOld=await pending.promise;
  await provider.respond([{role:'user',content:'old-idle'}],[],AbortSignal.timeout(2000));
  const oldIdle=[...(provider['sockets']?.pool['slots']??[])].find(slot=>!slot.busy)?.ws.socket.platformSocket;
  if(!oldIdle)throw new TypeError('idle fixture socket missing');
  const idleClosed=new Promise<void>(resolve=>oldIdle.once('close',()=>resolve()));
  await atomicSecret(file,{...credential,access_token:'new-fixture'});
  expect((await provider.respond([{role:'user',content:'new'}],[],AbortSignal.timeout(2000))).output_text).toBe('new-finished');
  await idleClosed;expect(oldIdle.readyState).toBe(3);
  completeOld();expect((await old).output_text).toBe('old-finished');
  expect((await provider.respond([{role:'user',content:'new-again'}],[],AbortSignal.timeout(2000))).output_text).toBe('new-finished');
  expect(h.auth).toEqual(['Bearer old-fixture','Bearer old-fixture','Bearer new-fixture']);expect(h.requests.map(r=>r.connection)).toEqual([1,2,3,3]);expect(provider['retiredPools'].size).toBe(0);
  await atomicSecret(file,{...credential,subject:'different',access_token:'third-fixture'});await expect(provider.respond([],[],AbortSignal.timeout(1000))).rejects.toThrow('identity changed');expect(h.requests).toHaveLength(4);
 }finally{provider.close();if(previous===undefined)delete process.env['OPENAI_BASE_URL'];else process.env['OPENAI_BASE_URL']=previous;h.close();await rm(dir,{recursive:true,force:true});}
});

for(const fault of ['named-error','duplicate-index'] as const)test(`implicit ${fault} fails closed before accepting completion`,async()=>{
 const h=harness(socket=>{begin(socket,'response','known');if(fault==='named-error')socket.send(JSON.stringify({type:'error',stream_id:'unrelated',error:{code:'invalid_request_error'}}));else socket.send(JSON.stringify({type:'response.output_item.added',output_index:0,item:{id:'different'}}));finish(socket,'response','known','must-not-return');});
 const pool=new ResponseSocketPool(new OpenAI({apiKey:'fixture',baseURL:h.url}),{lane:'implicit'});
 try{await expect(pool.respond(body('fixture'),AbortSignal.timeout(1000))).rejects.toThrow();expect(h.requests).toHaveLength(1);}
 finally{pool.close();h.close();}
});

test('implicit codex metadata is informational before and during a response, never output or identity',async()=>{
 const h=harness(socket=>{socket.send(JSON.stringify({type:'codex.response.metadata',response:{id:'fake'},output:[{text:'must-ignore'}]}));begin(socket,'actual','actual-item');socket.send(JSON.stringify({type:'codex.response.metadata',item_id:'fake',response:{id:'another'}}));socket.send(JSON.stringify({type:'responsesapi.websocket_timing',response:{id:'fake',status:'completed'}}));finish(socket,'actual','actual-item','correct');});
 const pool=new ResponseSocketPool(new OpenAI({apiKey:'fixture',baseURL:h.url}),{lane:'implicit'});
 try{const result=await pool.respond(body('fixture'),AbortSignal.timeout(1000));expect(result.id).toBe('actual');expect(result.output_text).toBe('correct');}
 finally{pool.close();h.close();}
});
for(const type of ['codex.response.metadata','responsesapi.websocket_timing'])test(`${type} alone followed by close cannot complete implicit response`,async()=>{
 const h=harness(socket=>{socket.send(JSON.stringify({type,response:{id:'fake',status:'completed',output:[]}}));socket.terminate();});const pool=new ResponseSocketPool(new OpenAI({apiKey:'fixture',baseURL:h.url}),{lane:'implicit'});
 try{await expect(pool.respond(body('fixture'),AbortSignal.timeout(1000))).rejects.toThrow();expect(h.requests).toHaveLength(1);}
 finally{pool.close();h.close();}
});
