import {test,expect} from 'bun:test';
import {WebSocketServer,type WebSocket} from 'ws';
import OpenAI from 'openai';
import {z} from 'zod';
import {ResponseSocketPool} from '../packages/provider/websocket.ts';
import {OpenAIProvider} from '../packages/provider/index.ts';
const Request=z.object({type:z.literal('response.create'),stream_id:z.string(),input:z.unknown(),model:z.string(),service_tier:z.string(),store:z.boolean(),previous_response_id:z.string().optional(),stream:z.boolean().optional(),include:z.array(z.string()).optional(),tools:z.array(z.unknown()).optional(),parallel_tool_calls:z.boolean()});
type Request=z.infer<typeof Request>;
type Socket=WebSocket;
function created(socket:Socket,request:Request){socket.send(JSON.stringify({type:'response.created',stream_id:request.stream_id,response:{id:`resp_${request.stream_id}`,status:'in_progress',output:[]}}));}
function completed(socket:Socket,request:Request,text:string,overrides:Readonly<Record<string,unknown>>={}){socket.send(JSON.stringify({type:'response.completed',stream_id:request.stream_id,response:{id:`resp_${request.stream_id}`,status:'completed',service_tier:'default',output:[{type:'message',id:'message',role:'assistant',status:'completed',phase:'final_answer',content:[{type:'output_text',text,annotations:[]}]}],...overrides}}));}
function harness(handler:(socket:Socket,request:Request)=>void){
 let connections=0;const requests:Array<{request:Request;socketId:number}>=[];
 const socketServer=new WebSocketServer({port:0});
 const address=socketServer.address();if(typeof address==='string'||!address)throw new TypeError('fixture address missing');
 socketServer.on('connection',socket=>{const id=++connections;socket.on('message',data=>{const request=Request.parse(JSON.parse(String(data)));requests.push({request,socketId:id});handler(socket,request);});});
 const server={url:new URL(`http://127.0.0.1:${address.port}`),stop:(_force:boolean)=>{for(const socket of socketServer.clients)socket.terminate();socketServer.close();}};
 const client=new OpenAI({apiKey:'synthetic-test-secret',baseURL:server.url.href,maxRetries:0});
 return {server,client,requests};
}
const body=(text:string)=>({model:'gpt-6-astra',input:[{role:'user' as const,content:text}],stream:true as const,store:false,parallel_tool_calls:false,include:['reasoning.encrypted_content' as const],reasoning:{effort:'low' as const}});
test('WebSocket forwards actual correlated text lifecycle to the observer',async()=>{
 const seen:string[]=[];
 const h=harness((socket,request)=>{
  created(socket,request);
  socket.send(JSON.stringify({type:'response.output_item.added',stream_id:request.stream_id,output_index:0,item:{type:'message',id:'reply',role:'assistant',status:'in_progress',content:[]}}));
  socket.send(JSON.stringify({type:'response.output_text.delta',stream_id:request.stream_id,item_id:'reply',output_index:0,content_index:0,delta:'visible',logprobs:[]}));
  socket.send(JSON.stringify({type:'response.output_text.done',stream_id:request.stream_id,item_id:'reply',output_index:0,content_index:0,text:'visible',logprobs:[]}));
  completed(socket,request,'visible');
 });
 const pool=new ResponseSocketPool(h.client);
 try{await pool.respond(body('fixture'),AbortSignal.timeout(3000),event=>seen.push(event.type));expect(seen).toEqual(['text_delta','text_done','response_done']);}
 finally{pool.close();await h.server.stop(true);}
});
test('persistent socket sends exact fresh full history/default tier and ignores stale prior lane events',async()=>{
 let previous:Request|undefined;
 const h=harness((socket,request)=>{if(previous){completed(socket,previous,'STALE');socket.send(JSON.stringify({type:'error',stream_id:previous.stream_id,error:{code:'stale',message:'old request'}}));}created(socket,request);completed(socket,request,JSON.stringify(request.input));previous=request;});
 const pool=new ResponseSocketPool(h.client);
 try{
  await pool.respond(body('old-image-context'),AbortSignal.timeout(3000));
  const response=await pool.respond(body('pruned-current-context'),AbortSignal.timeout(3000));
  expect(response.output_text).toBe(JSON.stringify(body('pruned-current-context').input));
  expect(h.requests.map(r=>r.socketId)).toEqual([1,1]);
  expect(h.requests[0]?.request.stream_id).not.toBe(h.requests[1]?.request.stream_id);
  expect(h.requests.every(r=>r.request.previous_response_id===undefined&&r.request.stream===undefined&&r.request.service_tier==='default'&&r.request.store===false)).toBe(true);
  expect(h.requests[1]?.request.input).toEqual(body('pruned-current-context').input);
  expect(h.requests[1]?.request.include).toEqual(['reasoning.encrypted_content']);
 }finally{pool.close();await h.server.stop(true);}
});
test('concurrent main/memory calls use separate sockets and abort only owning generation',async()=>{
 const main=Promise.withResolvers<void>();
 const h=harness((socket,request)=>{created(socket,request);if(JSON.stringify(request.input).includes('main'))main.resolve();else completed(socket,request,'memory-complete');});
 const pool=new ResponseSocketPool(h.client),abort=new AbortController();
 try{
  const first=pool.respond(body('main'),abort.signal);await main.promise;
  const memory=pool.respond(body('memory'),AbortSignal.timeout(3000));abort.abort();
  await expect(first).rejects.toThrow();expect((await memory).output_text).toBe('memory-complete');
  expect(h.requests[0]?.socketId).not.toBe(h.requests[1]?.socketId);
  expect((await pool.respond(body('next-memory'),AbortSignal.timeout(3000))).output_text).toBe('memory-complete');
  expect(h.requests[2]?.socketId).toBe(h.requests[1]?.socketId);
 }finally{pool.close();await h.server.stop(true);}
});
for(const fault of ['close','error','malformed','incomplete','identity','uncorrelated','unknown','oauth-metadata'] as const)test(`WebSocket ${fault} cannot return partial output or retry`,async()=>{
 const h=harness((socket,request)=>{
  created(socket,request);socket.send(JSON.stringify({type:'response.output_text.delta',stream_id:request.stream_id,delta:'partial'}));
  switch(fault){
   case 'close':socket.terminate();break;
   case 'error':socket.send(JSON.stringify({type:'error',stream_id:request.stream_id,error:{code:'synthetic-private-error',message:'must not expose'}}));break;
   case 'malformed':socket.send('{invalid');break;
   case 'incomplete':socket.send(JSON.stringify({type:'response.incomplete',stream_id:request.stream_id,response:{id:`resp_${request.stream_id}`,status:'incomplete',output:[]}}));break;
   case 'identity':completed(socket,request,'bad',{id:'another-response'});break;
   case 'oauth-metadata':socket.send(JSON.stringify({type:'responsesapi.websocket_timing',stream_id:request.stream_id}));completed(socket,request,'must-not-return');break;
   case 'unknown':socket.send(JSON.stringify({type:'response.not_a_real_event',stream_id:request.stream_id}));completed(socket,request,'must-not-return');break;
   case 'uncorrelated':socket.send(JSON.stringify({type:'response.completed',response:{id:`resp_${request.stream_id}`,output:[]}}));break;
   default:unreachable(fault);
  }
 });
 const pool=new ResponseSocketPool(h.client,{requestTimeoutMs:500});
 try{await expect(pool.respond(body('fixture'),AbortSignal.timeout(2000))).rejects.toThrow();expect(h.requests).toHaveLength(1);}
 finally{pool.close();await h.server.stop(true);}
});
test('idle timeout and explicit close retire sockets deterministically',async()=>{
 const h=harness((socket,request)=>{created(socket,request);completed(socket,request,'ok');}),pool=new ResponseSocketPool(h.client,{idleTimeoutMs:15});
 try{
  await pool.respond(body('one'),AbortSignal.timeout(3000));await awaitPoolClose(pool);await pool.respond(body('two'),AbortSignal.timeout(3000));expect(h.requests.map(r=>r.socketId)).toEqual([1,2]);
  pool.close();await expect(pool.respond(body('closed'),AbortSignal.timeout(3000))).rejects.toThrow('closed');
 }finally{pool.close();await h.server.stop(true);}
});
test('optional transport never upgrades tier or chains history',async()=>{
 const h=harness(()=>{throw new TypeError('must not send');}),pool=new ResponseSocketPool(h.client);
 try{
  await expect(pool.respond({...body('bad'),service_tier:'priority'},AbortSignal.timeout(1000))).rejects.toThrow('default');
  await expect(pool.respond({...body('bad'),previous_response_id:'old'},AbortSignal.timeout(1000))).rejects.toThrow('full history');expect(h.requests).toHaveLength(0);
 }finally{pool.close();await h.server.stop(true);}
});
function unreachable(_value:never):never{throw new TypeError('unreachable fixture');}

test('pool close while reader is pending settles promptly without retry',async()=>{
 const started=Promise.withResolvers<void>();const h=harness((socket,request)=>{created(socket,request);started.resolve();});
 const pool=new ResponseSocketPool(h.client);
 try{const result=pool.respond(body('pending'),AbortSignal.timeout(1000));await started.promise;pool.close();await expect(result).rejects.toThrow();expect(h.requests).toHaveLength(1);}
 finally{pool.close();await h.server.stop(true);}
},1500);
test('socket retires at32 unique lanes',async()=>{
 const h=harness((socket,request)=>{created(socket,request);completed(socket,request,'ok');});const pool=new ResponseSocketPool(h.client);
 try{for(let i=0;i<33;i++)await pool.respond(body(String(i)),AbortSignal.timeout(1000));expect(new Set(h.requests.slice(0,32).map(r=>r.socketId)).size).toBe(1);expect(h.requests[32]?.socketId).toBe(2);}
 finally{pool.close();await h.server.stop(true);}
});
test('OpenAIProvider WebSocket option preserves exact function schema and uses fixeddefault',async()=>{
 const h=harness((socket,request)=>{created(socket,request);completed(socket,request,'ok');});
 const previous=process.env['OPENAI_BASE_URL'];process.env['OPENAI_BASE_URL']=h.server.url.href;
 const provider=new OpenAIProvider({mode:'api',model:'gpt-6-astra',apiKey:'fixture',reasoningEffort:'low',transport:'websocket'});
 const tool={type:'function' as const,name:'echo',description:'fixture',strict:true,parameters:{type:'object',properties:{text:{type:'string'}},required:['text'],additionalProperties:false}};
 try{expect((await provider.respond([{role:'user',content:'hello'}],[tool],AbortSignal.timeout(1000))).output_text).toBe('ok');expect(h.requests[0]?.request.tools).toEqual([tool]);expect(h.requests[0]?.request.parallel_tool_calls).toBe(true);expect(h.requests[0]?.request.service_tier).toBe('default');}
 finally{provider.close();if(previous===undefined)delete process.env['OPENAI_BASE_URL'];else process.env['OPENAI_BASE_URL']=previous;await h.server.stop(true);}
});

test('server idle close is retired and next call opens a new socket',async()=>{
 const h=harness((socket,request)=>{created(socket,request);completed(socket,request,'ok');setTimeout(()=>socket.close(1000),5);}),pool=new ResponseSocketPool(h.client);
 try{await pool.respond(body('one'),AbortSignal.timeout(1000));await awaitPoolClose(pool);await pool.respond(body('two'),AbortSignal.timeout(1000));expect(h.requests.map(r=>r.socketId)).toEqual([1,2]);}
 finally{pool.close();await h.server.stop(true);}
});
test('unexpected returned paid tier is rejected without retry',async()=>{
 const h=harness((socket,request)=>{created(socket,request);completed(socket,request,'ok',{service_tier:'priority'});}),pool=new ResponseSocketPool(h.client);
 try{await expect(pool.respond(body('fixture'),AbortSignal.timeout(1000))).rejects.toThrow('unexpected service tier');expect(h.requests).toHaveLength(1);expect(h.requests[0]?.request.service_tier).toBe('default');}
 finally{pool.close();await h.server.stop(true);}
});

async function awaitClosed(closed:Promise<void>):Promise<void>{
 let timer:ReturnType<typeof setTimeout>|undefined;
 try{await Promise.race([closed,new Promise<void>((_resolve,reject)=>{timer=setTimeout(()=>reject(new TypeError('fixture close deadline')),1000);})]);}
 finally{clearTimeout(timer);}
}

async function awaitPoolClose(pool:ResponseSocketPool):Promise<void>{
 const socket=[...pool['slots']][0]?.ws.socket.platformSocket;
 if(!socket||socket.readyState===3)return;
 await awaitClosed(new Promise<void>(resolve=>socket.once('close',()=>resolve())));
}
