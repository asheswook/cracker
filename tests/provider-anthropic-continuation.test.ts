import Anthropic from "@anthropic-ai/sdk";
import {AnthropicContinuation} from "../packages/provider/anthropic-continuation.ts";
import {test,expect} from 'bun:test';
import type {ProviderResponseObserver,ResponseInputItem} from '../packages/provider/index.ts';
import type {ContinuationReader} from '../packages/provider/continuation.ts';
import {fixture,message,wire,model} from './anthropic-context-fixture.ts';
const frame=(event:{type:string})=>`event: ${event.type}\ndata: ${JSON.stringify(event)}\n\n`;
const prefix=()=>[
 {type:'message_start',message:{...message([]),stop_reason:null}},
 {type:'content_block_start',index:0,content_block:{type:'thinking',thinking:'',signature:''}},
 {type:'content_block_delta',index:0,delta:{type:'thinking_delta',thinking:'completed thought'}},
 {type:'content_block_delta',index:0,delta:{type:'signature_delta',signature:'signed-A'}},
 {type:'content_block_stop',index:0},
 {type:'content_block_start',index:1,content_block:{type:'text',text:''}},
 {type:'content_block_delta',index:1,delta:{type:'text_delta',text:'completed text'}},
 {type:'content_block_stop',index:1},
 {type:'content_block_start',index:2,content_block:{type:'thinking',thinking:'',signature:''}},
 {type:'content_block_delta',index:2,delta:{type:'thinking_delta',thinking:'unfinished B'}},
 {type:'content_block_delta',index:2,delta:{type:'signature_delta',signature:'signed-but-unfinished'}},
].map(frame).join('');
for(const native of [false,true])test(`${native?'native':'standard'} Claude retains only signed completed prefix across steering cancellation`,async()=>{
 // Given a real SDK SSE stream with completed signed A followed by unsigned unfinished B.
 const seen=Promise.withResolvers<void>(),abort=new AbortController();let read:ContinuationReader=()=>undefined;
 const observer:ProviderResponseObserver=Object.assign((event:Parameters<ProviderResponseObserver>[0])=>{if(event.type==='text_delta')seen.resolve();},{continuation:(reader:ContinuationReader)=>{read=reader;}});
 const f=fixture({respond:(_body,index)=>index===1?new Response(new ReadableStream({start(controller){controller.enqueue(new TextEncoder().encode(prefix()));}}),{headers:{'content-type':'text/event-stream'}}):new Response(wire(message([{type:'text',text:'continued'}])),{headers:{'content-type':'text/event-stream'}})});
 const input:ResponseInputItem[]=[{role:'user',content:'think'}],runId=crypto.randomUUID(),clock='fixed clock';
 try{
  const pending=native?f.provider.nativeContext.respond({runId,input,tools:[],signal:abort.signal,clock,observer}):f.provider.respond(input,[],abort.signal,observer);
  const settled=pending.then(()=>false,()=>true);
  await seen.promise;abort.abort();expect(await settled).toBe(true);
  // When only received completed blocks are reused with fresh user steering.
  const saved=read();expect(saved).toBeDefined();if(!saved)throw new Error('missing continuation');
  expect(saved.output.map(item=>item.type)).toEqual(['reasoning','message']);
  expect(JSON.stringify(saved)).toContain('signed-A');expect(JSON.stringify(saved)).not.toContain('unfinished B');
  const next:ResponseInputItem[]=[...input,...saved.output.filter(item=>item.type==='message'||item.type==='reasoning'||item.type==='function_call'),{role:'user',content:'new steering'}];
  if(native){expect(saved.nativeContext?.reply?.content).toEqual([{type:'thinking',thinking:'completed thought',signature:'signed-A'},{type:'text',text:'completed text'}]);await f.provider.nativeContext.respond({runId,input:next,tools:[],signal:AbortSignal.timeout(2000),clock,...(saved.nativeContext?{state:saved.nativeContext}:{})});}
  else await f.provider.respond(next,[],AbortSignal.timeout(2000));
  // Then the next real HTTP request preserves A exactly and never includes unfinished B.
  expect(f.requests).toHaveLength(2);expect(JSON.stringify(f.requests[1])).toContain('signed-A');expect(JSON.stringify(f.requests[1])).not.toContain('unfinished B');expect(f.requests[1]?.model).toBe(model);
 }finally{abort.abort();await f.close();}
});

for(const invalid of ['unsigned','model','transformation'] as const)test(`Claude continuation rejects ${invalid} prefix without changing cancellation behavior`,async()=>{
 const seen=Promise.withResolvers<void>(),abort=new AbortController();let read:ContinuationReader=()=>undefined;
 const observer:ProviderResponseObserver=Object.assign((event:Parameters<ProviderResponseObserver>[0])=>{if(event.type==='text_delta')seen.resolve();},{continuation:(reader:ContinuationReader)=>{read=reader;}});
 let data=prefix();
 if(invalid==='unsigned')data=data.replace('"signature":"signed-A"','"signature":""');
 if(invalid==='model')data=data.replace(`"model":"${model}"`,'"model":"wrong-model"');
 if(invalid==='transformation')data=data.replace('"stop_reason":null','"stop_reason":null,"input_transformations":[{"type":"thinking_stripped"}]');
 const f=fixture({respond:()=>new Response(new ReadableStream({start(controller){controller.enqueue(new TextEncoder().encode(data));}}),{headers:{'content-type':'text/event-stream'}})});
 try{
  const done=f.provider.nativeContext.respond({runId:crypto.randomUUID(),input:[{role:'user',content:'fixture'}],tools:[],signal:abort.signal,clock:'clock',observer}).then(()=>false,()=>true);
  await seen.promise;abort.abort();expect(await done).toBe(true);expect(read()).toBeUndefined();
 }finally{abort.abort();await f.close();}
});

test('native continuation preserves redacted block and trailing partial text as an exact draft',async()=>{
 const seen=Promise.withResolvers<void>(),abort=new AbortController();let read:ContinuationReader=()=>undefined;
 const observer:ProviderResponseObserver=Object.assign((event:Parameters<ProviderResponseObserver>[0])=>{if(event.type==='text_delta')seen.resolve();},{continuation:(reader:ContinuationReader)=>{read=reader;}});
 const events=[{type:'message_start',message:{...message([]),stop_reason:null}},{type:'content_block_start',index:0,content_block:{type:'redacted_thinking',data:'opaque-A'}},{type:'content_block_stop',index:0},{type:'content_block_start',index:1,content_block:{type:'text',text:''}},{type:'content_block_delta',index:1,delta:{type:'text_delta',text:'partial draft'}}];
 const f=fixture({respond:(_body,index)=>index===1?new Response(new ReadableStream({start(controller){controller.enqueue(new TextEncoder().encode(events.map(frame).join('')));}}),{headers:{'content-type':'text/event-stream'}}):new Response(wire(message([{type:'text',text:'new answer'}])),{headers:{'content-type':'text/event-stream'}})});
 const input:ResponseInputItem[]=[{role:'user',content:'fixture'}],runId=crypto.randomUUID();
 try{
  const done=f.provider.nativeContext.respond({runId,input,tools:[],signal:abort.signal,clock:'clock',observer}).then(()=>false,()=>true);
  await seen.promise;abort.abort();expect(await done).toBe(true);const saved=read();expect(saved).toBeDefined();if(!saved?.nativeContext)throw new Error('missing native draft');
  expect(saved.output.at(-1)).toMatchObject({type:'message',status:'incomplete'});
  expect(saved.nativeContext.reply?.content).toEqual([{type:'redacted_thinking',data:'opaque-A'},{type:'text',text:'partial draft'}]);
  await f.provider.nativeContext.respond({runId,input:[...input,...saved.output.filter(item=>item.type==='message'||item.type==='reasoning'),{role:'user',content:'steer'}],tools:[],signal:AbortSignal.timeout(2000),clock:'clock',state:saved.nativeContext});
  expect(JSON.stringify(f.requests[1])).toContain('opaque-A');expect(JSON.stringify(f.requests[1])).toContain('partial draft');
 }finally{abort.abort();await f.close();}
});

test('completed tool JSON is retained while partial JSON is excluded',async()=>{
 const seen=Promise.withResolvers<void>(),abort=new AbortController();let read:ContinuationReader=()=>undefined;
 const observer:ProviderResponseObserver=Object.assign((event:Parameters<ProviderResponseObserver>[0])=>{if(event.type==='text_delta')seen.resolve();},{continuation:(reader:ContinuationReader)=>{read=reader;}});
 const events=[{type:'message_start',message:{...message([]),stop_reason:null}},
 {type:'content_block_start',index:0,content_block:{type:'tool_use',id:'complete-call',name:'unoffered',input:{}}},
 {type:'content_block_delta',index:0,delta:{type:'input_json_delta',partial_json:'{"value":42}'}},{type:'content_block_stop',index:0},
 {type:'content_block_start',index:1,content_block:{type:'text',text:''}},{type:'content_block_delta',index:1,delta:{type:'text_delta',text:'received'}},{type:'content_block_stop',index:1},
 {type:'content_block_start',index:2,content_block:{type:'tool_use',id:'partial-call',name:'shell',input:{}}},{type:'content_block_delta',index:2,delta:{type:'input_json_delta',partial_json:'{"value":'}},
 ];
 const f=fixture({respond:()=>new Response(new ReadableStream({start(controller){controller.enqueue(new TextEncoder().encode(events.map(frame).join('')));}}),{headers:{'content-type':'text/event-stream'}})});
 try{
  const done=f.provider.respond([{role:'user',content:'fixture'}],[],abort.signal,observer).then(()=>false,()=>true);
  await seen.promise;abort.abort();expect(await done).toBe(true);const saved=read();expect(saved?.output[0]).toMatchObject({type:'function_call',call_id:'complete-call',name:'unoffered',arguments:'{"value":42}'});expect(JSON.stringify(saved)).not.toContain('partial-call');
 }finally{abort.abort();await f.close();}
});

for(const native of [false,true])test(`${native?'native':'standard'} retry resets continuation before a new stream attempt`,async()=>{
 // Given a failed first SSE attempt with completed signed data and a held second attempt.
 const second=Promise.withResolvers<void>(),abort=new AbortController();let read:ContinuationReader=()=>undefined,seen=0;const registrationSnapshots:unknown[]=[],readers:ContinuationReader[]=[];
 const observer:ProviderResponseObserver=Object.assign((event:Parameters<ProviderResponseObserver>[0])=>{if(event.type==='text_delta'&&++seen===2)second.resolve();},{continuation:(reader:ContinuationReader)=>{registrationSnapshots.push(reader());readers.push(reader);read=reader;}});
 const fresh=[{type:'message_start',message:{...message([],'end_turn','retry-second'),stop_reason:null}},{type:'content_block_start',index:0,content_block:{type:'text',text:''}},{type:'content_block_delta',index:0,delta:{type:'text_delta',text:'second draft'}}].map(frame).join('');
 const f=fixture({respond:(_body,index)=>index===1?new Response(prefix(),{headers:{'content-type':'text/event-stream'}}):new Response(new ReadableStream({start(controller){controller.enqueue(new TextEncoder().encode(fresh));}}),{headers:{'content-type':'text/event-stream'}})});
 try{
  const input:ResponseInputItem[]=[{role:'user',content:'fixture'}];
  const budget={attempts:2,totalMs:1500,maxDelayMs:1000};
  const work=native?f.provider.nativeContext.respond({runId:crypto.randomUUID(),input,tools:[],signal:abort.signal,clock:'clock',observer,budget}):f.provider.respond(input,[],abort.signal,observer,budget);
  const done=work.then(()=>false,()=>true);await second.promise;abort.abort();expect(await done).toBe(true);
  // Then the lazy reader exposes only the second attempt, never its predecessor's signed block.
  expect(f.requests).toHaveLength(2);expect(registrationSnapshots.every(snapshot=>snapshot===undefined)).toBe(true);expect(readers.slice(0,-1).every(reader=>reader()===undefined)).toBe(true);
  expect(read()?.responseId).toBe('retry-second');expect(JSON.stringify(read())).not.toContain('signed-A');expect(read()?.output).toHaveLength(1);
 }finally{abort.abort();await f.close();}
});

test('abort freezes SDK snapshot before late mutation and queued block-stop',async()=>{
 // Given the real SDK's mutable snapshot after signed block A completed.
 const capture=new AnthropicContinuation(model),abort=new AbortController();
 const f=fixture({respond:()=>new Response(wire(message([{type:'thinking',thinking:'A',signature:'sig-A'}])),{headers:{'content-type':'text/event-stream'}})});
 const client=new Anthropic({apiKey:'fixture',baseURL:f.server.url.href,maxRetries:0});
 abort.signal.addEventListener('abort',()=>capture.freeze?.(),{once:true});
 try{
  const stream=client.messages.stream({model,max_tokens:100,messages:[{role:'user',content:'fixture'}]});
  stream.on('streamEvent',(event,snapshot)=>{
   capture.accept(event,snapshot);
   if(event.type==='content_block_stop'&&event.index===0){
    // When cancellation is synchronous but buffered transport events arrive before stream settlement.
    abort.abort();
    const first=snapshot.content[0];if(first?.type==='thinking')first.signature='mutated-after-abort';
    snapshot.content.push({type:'thinking',thinking:'late B',signature:'sig-B'});
    capture.accept({type:'content_block_stop',index:1},snapshot);
   }
  });
  await stream.finalMessage();
  // Then only the exact prefix at abort is retained, even after later snapshot mutation.
  expect(capture.read()?.output).toHaveLength(1);
  expect(JSON.stringify(capture.read())).toContain('sig-A');
  expect(JSON.stringify(capture.read())).not.toContain('mutated-after-abort');
  expect(JSON.stringify(capture.read())).not.toContain('sig-B');
 }finally{await f.close();}
});
