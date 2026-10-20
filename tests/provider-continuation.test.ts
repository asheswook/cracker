import { expect, test } from 'bun:test';
import OpenAI from 'openai';
import { WebSocketServer } from 'ws';
import { z } from 'zod';
import { OpenAIProvider, type ProviderResponseObserver } from '../packages/provider/index.ts';
import type { ContinuationReader } from '../packages/provider/continuation.ts';
import type { ResponseOutputItem } from 'openai/resources/responses/responses';

const reasoning:ResponseOutputItem={type:'reasoning',id:'reasoning-A',summary:[],encrypted_content:'completed-cipher-A',status:'completed'};
const pending:ResponseOutputItem={type:'reasoning',id:'reasoning-B',summary:[],encrypted_content:'incomplete-cipher-B',status:'in_progress'};
const text:ResponseOutputItem={type:'message',id:'completed-text',role:'assistant',status:'completed',content:[{type:'output_text',text:'completed text',annotations:[]}]};
const call:ResponseOutputItem={type:'function_call',id:'completed-tool',call_id:'call-complete',name:'shell',arguments:'{"command":"pwd"}',status:'completed'};
const marker={type:'message',id:'marker',role:'assistant',status:'in_progress',content:[]} satisfies ResponseOutputItem;
const created={type:'response.created',response:{id:'resp_first',status:'in_progress',output:[]}};
const complete={type:'response.completed',response:{id:'resp_second',status:'completed',output:[text]}};
function frames(mode:'prefix'|'gap'|'tools'|'draft'|'partialtool'|'invalidtool'|'identity'|'failure'):Record<string,unknown>[] {
 const events:Record<string,unknown>[]=[created];
 const items=mode==='tools'?[reasoning,text,call]:mode==='invalidtool'?[reasoning,{...call,arguments:'[]'},{...reasoning,id:'later-reasoning'}]:[reasoning];
 for(const [index,item] of items.entries())events.push({type:'response.output_item.added',output_index:index,item},{type:'response.output_item.done',output_index:index,item});
 if(mode!=='draft')events.push({type:'response.output_item.added',output_index:items.length,item:mode==='partialtool'?{...call,id:'partial-tool',status:'in_progress',arguments:'{'}:pending});
 if(mode==='gap')events.push({type:'response.output_item.done',output_index:items.length+1,item:{...reasoning,id:'reasoning-C',encrypted_content:'later-cipher-C'}});
 if(mode==='identity')events.push({type:'response.created',response:{id:'different-response',output:[]}});
 events.push({type:'response.output_item.added',output_index:mode==='draft'?items.length:items.length+2,item:marker},{type:'response.output_text.delta',item_id:'marker',output_index:mode==='draft'?items.length:items.length+2,content_index:0,delta:'ready',logprobs:[]});
 if(mode==='failure')events.push({type:'response.failed',response:{id:'resp_first',output:[],error:{code:'server_error',message:'fixture'}}});
 return events.map((event,sequence_number)=>({...event,sequence_number}));
}
async function fixture(transport:'http'|'websocket',events:Record<string,unknown>[],closeAfter=false){
 const bodies:Record<string,unknown>[]=[],sent=Promise.withResolvers<void>();
 const socketServer=transport==='websocket'?new WebSocketServer({port:0}):undefined;
 const http=transport==='http'?Bun.serve({port:0,async fetch(request){
  bodies.push(z.record(z.string(),z.unknown()).parse(await request.json()));
  if(bodies.length>1)return new Response(`data: ${JSON.stringify(complete)}\n\n`,{headers:{'content-type':'text/event-stream'}});
  return new Response(new ReadableStream<Uint8Array>({start(controller){controller.enqueue(new TextEncoder().encode(events.map(event=>`data: ${JSON.stringify(event)}\n\n`).join('')));sent.resolve();if(closeAfter)controller.close();}}),{headers:{'content-type':'text/event-stream'}});
 }}):undefined;
 socketServer?.on('connection',socket=>socket.on('message',data=>{
  const body=z.record(z.string(),z.unknown()).parse(JSON.parse(String(data)));bodies.push(body);
  for(const event of bodies.length===1?events:[{type:'response.created',response:{id:'resp_second',output:[]}},complete])socket.send(JSON.stringify({...event,stream_id:body['stream_id']}));
  sent.resolve();if(closeAfter&&bodies.length===1)socket.close();
 }));
 const address=socketServer?.address();
 const url=http?.url.href??(address&&typeof address!=='string'?`http://127.0.0.1:${address.port}`:undefined);
 if(!url)throw new TypeError('Missing fixture address');
 const client=new OpenAI({apiKey:'fixture',baseURL:url,maxRetries:0});
 return {client,bodies,sent,close:async()=>{await http?.stop(true);if(socketServer){for(const socket of socketServer.clients)socket.terminate();socketServer.close();}}};
}

for(const transport of ['http','websocket'] as const)for(const mode of ['prefix','gap','tools','draft','partialtool','invalidtool'] as const)test(`${transport} steering continuation retains only the completed contiguous ${mode} prefix`,async()=>{
 // Given a genuine SDK stream with completed encrypted reasoning and a later unfinished item.
 const f=await fixture(transport,frames(mode)),abort=new AbortController();let read:ContinuationReader=()=>undefined;
 const observer:ProviderResponseObserver=Object.assign((event:{type:string})=>{if(event.type==='text_delta')abort.abort();},{continuation:(reader:ContinuationReader)=>{read=reader;}});
 const provider=new OpenAIProvider({mode:'api',model:'fixture',apiKey:'fixture',transport},f.client);
 try{
  // When steering cancels consumption after the completed item but before terminal completion.
  await expect(provider.respond([{role:'user',content:'first'}],[],abort.signal,observer)).rejects.toThrow();
  const retained=read();
  // Then the next real request can replay the complete prefix without incomplete reasoning or arguments.
  expect(retained?.responseId).toBe('resp_first');expect(retained?.output).toEqual(mode==='tools'?[reasoning,text,call]:mode==='draft'?[reasoning,{...marker,status:'incomplete',content:[{type:'output_text',text:'ready',annotations:[]}]}]:[reasoning]);
  if(!retained)throw new TypeError('Missing continuation');
  const replay=retained.output.filter(item=>item.type==='reasoning'||item.type==='message'||item.type==='function_call');expect(replay).toHaveLength(retained.output.length);
  expect((await provider.respond([...replay,{role:'user',content:'changed request'}],[],new AbortController().signal)).output_text).toBe('completed text');
  expect(f.bodies).toHaveLength(2);expect(f.bodies[1]?.['input']).toEqual([...retained.output,{role:'user',content:'changed request'}]);
  expect(JSON.stringify(f.bodies[1])).not.toContain('incomplete-cipher-B');expect(JSON.stringify(f.bodies[1])).not.toContain('later-cipher-C');
 }finally{abort.abort();provider.close();await f.close();}
});

for(const transport of ['http','websocket'] as const)test(`${transport} mismatched response identity invalidates continuation`,async()=>{
 // Given completed reasoning followed by a different response identity on the same stream.
 const f=await fixture(transport,frames('identity')),abort=new AbortController();let read:ContinuationReader=()=>undefined;
 const observer:ProviderResponseObserver=Object.assign((event:{type:string})=>{if(event.type==='text_delta')abort.abort();},{continuation:(reader:ContinuationReader)=>{read=reader;}});
 const provider=new OpenAIProvider({mode:'api',model:'fixture',apiKey:'fixture',transport,onRetry:()=>abort.abort()},f.client);
 try{
  // When the stream is invalidated or interrupted after the identity conflict.
  await expect(provider.respond([],[],abort.signal,observer)).rejects.toThrow();
  // Then no partial response from that envelope can be reused.
  expect(read()).toBeUndefined();
 }finally{abort.abort();provider.close();await f.close();}
});

for(const transport of ['http','websocket'] as const)for(const failure of ['failed terminal','closed transport'] as const)test(`${transport} ${failure} clears continuation before retry backoff`,async()=>{
 // Given completed reasoning followed by a transient failed terminal event.
 const f=await fixture(transport,frames(failure==='failed terminal'?'failure':'prefix'),failure==='closed transport'),abort=new AbortController();let read:ContinuationReader=()=>undefined,retries=0;
 const beforeFailure:unknown[]=[];
 const observer:ProviderResponseObserver=Object.assign((event:{type:string})=>{if(event.type==='text_delta')beforeFailure.push(read()?.output);},{continuation:(reader:ContinuationReader)=>{read=reader;}});
 const provider=new OpenAIProvider({mode:'api',model:'fixture',apiKey:'fixture',transport,onRetry:()=>{retries++;expect(read()).toBeUndefined();abort.abort();}},f.client);
 try{
  // When retry policy observes the ordinary error rather than a steering cancellation.
  await expect(provider.respond([],[],abort.signal,observer)).rejects.toThrow();
  // Then failed-attempt output is already unavailable before another attempt starts.
  expect(beforeFailure).toEqual([[reasoning]]);expect(retries).toBe(1);expect(read()).toBeUndefined();expect(f.bodies).toHaveLength(1);
 }finally{abort.abort();provider.close();await f.close();}
});

test('a fresh HTTP attempt resets the reader before its response headers arrive',async()=>{
 // Given completed reasoning from a failed first attempt and a second request held before headers.
 const entered=Promise.withResolvers<void>(),release=Promise.withResolvers<void>(),abort=new AbortController();let requests=0,read:ContinuationReader=()=>undefined;
 const server=Bun.serve({port:0,async fetch(){
  if(++requests===1)return new Response(frames('failure').map(event=>`data: ${JSON.stringify(event)}\n\n`).join(''),{headers:{'content-type':'text/event-stream'}});
  entered.resolve();await release.promise;return new Response(`data: ${JSON.stringify(complete)}\n\n`,{headers:{'content-type':'text/event-stream'}});
 }});
 const observer:ProviderResponseObserver=Object.assign(()=>{},{continuation:(reader:ContinuationReader)=>{read=reader;}});
 const provider=new OpenAIProvider({mode:'api',model:'fixture',apiKey:'fixture'},new OpenAI({apiKey:'fixture',baseURL:server.url.href,maxRetries:0}));
 const pending=provider.respond([],[],abort.signal,observer);
 try{
  // When the retry has reached the server but a new stream is not yet available.
  await entered.promise;expect(read()).toBeUndefined();release.resolve();expect((await pending).output_text).toBe('completed text');
  // Then no earlier failed-attempt reasoning is offered as continuation.
  expect(read()).toBeUndefined();expect(requests).toBe(2);
 }finally{abort.abort();release.resolve();provider.close();await server.stop(true);}
});

for(const transport of ['http','websocket'] as const)test(`${transport} added reasoning never becomes completed continuation`,async()=>{
 // Given encrypted reasoning that was added but never emitted in output_item.done.
 const f=await fixture(transport,frames('prefix').filter(event=>event['type']!=='response.output_item.done')),abort=new AbortController();let read:ContinuationReader=()=>undefined;
 const observer:ProviderResponseObserver=Object.assign((event:{type:string})=>{if(event.type==='text_delta')abort.abort();},{continuation:(reader:ContinuationReader)=>{read=reader;}});
 const provider=new OpenAIProvider({mode:'api',model:'fixture',apiKey:'fixture',transport},f.client);
 try{
  // When steering aborts while only an unfinished first reasoning block exists.
  await expect(provider.respond([],[],abort.signal,observer)).rejects.toThrow();
  // Then the ciphertext from output_item.added cannot be replayed as completed reasoning.
  expect(read()).toBeUndefined();expect(f.bodies).toHaveLength(1);
 }finally{abort.abort();provider.close();await f.close();}
});
