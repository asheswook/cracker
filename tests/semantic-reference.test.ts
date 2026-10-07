import { expect, test } from "bun:test";
import { z } from "zod";
import ky from "ky";
import { LinkRequest, PrepareResult, SemanticContext, SemanticSource, SemanticSnapshotRequest } from "../packages/context/schema.ts";
import { SEMANTIC_REFERENCE_MAX_BYTES, secondaryReferenceContexts, semanticReference } from "../packages/context/reference.ts";
import { SemanticContexts } from "../services/daemon/semantic-context.ts";
import { SemanticCheckpoint } from "../services/daemon/semantic-context-state.ts";
import type { Provider } from "../packages/provider/index.ts";
function context() {
 const id=crypto.randomUUID(),task=crypto.randomUUID();
 const sources=Array.from({length:6},(_,index)=>SemanticSource.parse({message_id:crypto.randomUUID(),conversation_id:crypto.randomUUID(),task_id:task,sequence:index+1,role:'user',content:`Original evidence ${index}`,created_at:'2026-10-01T00:00:00.000Z',truncated:false,sha256:'a'.repeat(64),attachments:[],retention_allowed:true,linked_context_id:id}));
 const notes=sources.map(source=>({id:crypto.randomUUID(),kind:'decision',text:source.content,evidence:[{message_id:source.message_id,quote:source.content}],source_message_id:source.message_id,source_sha256:source.sha256,source_sequence:source.sequence,context_revision:source.sequence,basis:'user_statement',supersedes:null,superseded_by:null,valid_from:null,valid_to:null,recorded_at:'2026-10-01T00:00:00.000Z'}));
 return SemanticContext.parse({context_id:id,title:'Reference entity',scope:'Separate reference topic',revision:6,source_sequence:6,notes,recent_messages:sources,files:[],retrieval:{note_ids:[notes[1]?.id,notes[0]?.id],source_windows:[{message_id:sources[1]?.message_id,start:0,end:19},{message_id:sources[0]?.message_id,start:0,end:19}]}});
}
const Packet=z.object({message_id:z.uuid().nullable(),context:SemanticContext.nullable(),alternatives:z.array(SemanticContext),selection:z.object({status:z.enum(['confirmed','provisional','none']),uncertain:z.boolean()}),coverage:z.object({unavailable_context_ids:z.array(z.uuid())})});
function packet(item:Awaited<ReturnType<SemanticContexts['select']>>) {
 if(!('content' in item)||typeof item.content!=='string')throw new TypeError('Expected structured reference packet');return Packet.parse(JSON.parse(item.content));
}
test('shared reference preserves query rank, alternate identities and a null primary with bounded UTF-8 JSON',()=>{
 const primary=context(),alternatives=Array.from({length:5},()=>context());
 const secondary=secondaryReferenceContexts([primary,...alternatives],primary.context_id);expect(secondary.map(item=>item.context_id)).toEqual(alternatives.slice(0,3).map(item=>item.context_id));
 const result=semanticReference({message_id:crypto.randomUUID(),primary,alternatives:secondary,selection:{status:'confirmed',uncertain:false}});
 expect(result.context).toEqual(primary);expect(result.context?.retrieval).toEqual(primary.retrieval);
 const missing=semanticReference({message_id:crypto.randomUUID(),primary:null,alternatives,selection:{status:'none',uncertain:true}});expect(missing.context).toBeNull();expect(missing.alternatives).toHaveLength(3);expect(missing.selection.uncertain).toBe(true);
 for(const source of primary.recent_messages)source.content='😀🧩'.repeat(10000);
 const large=semanticReference({message_id:crypto.randomUUID(),primary,alternatives:[primary,...alternatives],selection:{status:'provisional',uncertain:true}});
 const encoded=JSON.stringify(large);expect(new TextEncoder().encode(encoded).byteLength).toBeLessThanOrEqual(SEMANTIC_REFERENCE_MAX_BYTES);expect(Packet.parse(JSON.parse(encoded)).alternatives).toHaveLength(3);expect(large.coverage.contexts.some(item=>item.content_truncated||item.sources_omitted>0)).toBe(true);
});
test('duplicate retrieval IDs preserve first-hit priority and unretained sources never enter reference text',()=>{
 const value=context(),first=value.retrieval.note_ids[0],second=value.retrieval.note_ids[1],window=value.retrieval.source_windows[0];if(!first||!second||!window)throw new TypeError('Missing fixture');
 value.retrieval.note_ids=[first,second,first];value.retrieval.source_windows=[window,...value.retrieval.source_windows];
 const denied=value.recent_messages.at(-1);if(!denied)throw new TypeError('Missing source');denied.retention_allowed=false;
 const result=semanticReference({message_id:crypto.randomUUID(),primary:value,alternatives:[value,value],selection:{status:'confirmed',uncertain:false}});
 expect(result.context?.retrieval.note_ids[0]).toBe(first);expect(result.context?.retrieval.source_windows[0]?.message_id).toBe(window.message_id);expect(result.context?.recent_messages.some(source=>source.message_id===denied.message_id)).toBe(false);expect(result.alternatives).toEqual([]);
});
async function fixture() {
 const contexts=Array.from({length:5},()=>context()),head=contexts[0];if(!head)throw new TypeError('No head');
 const run=crypto.randomUUID(),task=crypto.randomUUID(),source=SemanticSource.parse({message_id:crypto.randomUUID(),task_id:task,sequence:20,role:'user',content:'Compare the earlier records',sha256:'b'.repeat(64),retention_allowed:true,attachments:[],truncated:false});
 let selected=contexts,linked:ReturnType<typeof PrepareResult.parse>['linked']=null,modelCalls=0;
 const provisional=context(),flags={denied:false,outage:false,sourceChanged:false,nullRoute:false},links:z.infer<typeof LinkRequest>[]=[],snapshots:z.infer<typeof SemanticSnapshotRequest>[]=[];
 const server=Bun.serve({hostname:'127.0.0.1',port:0,fetch:async request=>{
  const path=new URL(request.url).pathname;
  if(path.endsWith('/prepare')){const body=z.object({message_id:z.uuid()}).parse(await request.json());return Response.json(PrepareResult.parse({source:{...source,message_id:body.message_id,...(flags.sourceChanged?{sha256:'c'.repeat(64)}:{})},retention_context:{sources:[],decisions:[]},neighbors:[],candidates:selected,linked,history:{messages:[],next_after_sequence:null,has_more:false},decision:{context_id:null,outcome:'uncertain',scores:[],model:'uncertain-classifier'}}));}
  if(path.endsWith('/link')){const body=LinkRequest.parse(await request.json());links.push(body);const target=body.choice.kind==='new'?provisional:head;linked={message_id:body.message_id,context_id:target.context_id,revision:1,status:body.status,source_sequence:20,source_sha256:source.sha256,evidence:body.evidence,originating_message_id:null};return Response.json({link:linked,context:target});}
  if(path.endsWith('/snapshot')){const body=SemanticSnapshotRequest.parse(await request.json());snapshots.push(body);if(flags.outage)return Response.json({error:'unavailable'},{status:503});const value=contexts.find(item=>item.context_id===body.context_id);if(!value)return Response.json({error:'missing'},{status:404});return Response.json({context:flags.denied&&value.context_id!==head.context_id?{...value,title:'Context',scope:'Retained evidence unavailable',notes:[],recent_messages:[],files:[]}:value});}
  throw new TypeError('References must not call metadata writes');
 }});
 const provider:Provider={respond:async(_input,tools)=>{modelCalls++;const tool=tools[0];if(tool?.type!=='function'||tool.name!=='select_semantic_context')throw new TypeError('Unexpected model call');return {id:crypto.randomUUID(),created_at:0,output_text:'',error:null,incomplete_details:null,instructions:null,metadata:null,model:'fixture',object:'response',output:[{type:'function_call',call_id:crypto.randomUUID(),name:tool.name,arguments:JSON.stringify({context_id:flags.nullRoute?null:head.context_id,title:'Fallback title',scope:'Fallback scope',confirmed:true})}],parallel_tool_calls:false,temperature:null,tool_choice:'auto',tools:[],top_p:null,status:'completed'};}};
 const scope={http:ky.create({prefixUrl:server.url.href,retry:0}),runId:run,taskId:task,provider};
 return {contexts,head,source,flags,links,snapshots,scope,make:(state?:SemanticCheckpoint)=>new SemanticContexts(scope,state),modelCalls:()=>modelCalls,onlyPrimary:()=>{selected=[head];},close:()=>server.stop(true)};
}
test('uncertain fallback keeps three read-only alternatives, singular provisional primary and only fresh input IDs',async()=>{
 const f=await fixture();try{
  const coordinator=f.make(),result=packet(await coordinator.select(f.source.message_id,AbortSignal.timeout(5000)));
  expect(result.context?.context_id).toBe(f.head.context_id);expect(result.alternatives.map(item=>item.context_id)).toEqual(f.contexts.slice(1,4).map(item=>item.context_id));expect(result.selection).toEqual({status:'provisional',uncertain:true});expect(f.links).toHaveLength(1);expect(f.links[0]?.status).toBe('provisional');expect(f.modelCalls()).toBe(1);
  expect(coordinator.checkpoint().fresh_sources).toEqual([{context_id:f.head.context_id,message_ids:[f.source.message_id]}]);expect(JSON.stringify(coordinator.checkpoint().reference)).not.toContain('Original evidence');
 }finally{await f.close();}
});
test('restore rehydrates hints and revocation, while a new input or deferred source cannot reuse prior auxiliary references',async()=>{
 const f=await fixture();try{
  const first=f.make();await first.select(f.source.message_id,AbortSignal.timeout(5000));const checkpoint=SemanticCheckpoint.parse(JSON.parse(JSON.stringify(first.checkpoint())));f.flags.denied=true;
  const restored=f.make(checkpoint),item=await restored.refreshReference(AbortSignal.timeout(5000));if(!item)throw new TypeError('No restored packet');expect(packet(item).alternatives.every(value=>value.notes.length===0&&value.recent_messages.length===0)).toBe(true);expect(f.modelCalls()).toBe(1);
  f.onlyPrimary();const next=crypto.randomUUID(),fresh=packet(await restored.select(next,AbortSignal.timeout(5000)));expect(fresh.message_id).toBe(next);expect(fresh.alternatives).toEqual([]);
  expect(packet(restored.deferSource(crypto.randomUUID())).alternatives).toEqual([]);expect(restored.checkpoint().reference).toBeUndefined();expect(await restored.refreshReference(AbortSignal.timeout(5000))).toBeNull();
 }finally{await f.close();}
});
test('failed hydration and changed source hashes produce bounded explicit unavailable references instead of stale evidence',async()=>{
 const f=await fixture();try{
  const controller=f.make();await controller.select(f.source.message_id,AbortSignal.timeout(5000));const saved=controller.checkpoint();f.flags.outage=true;
  const restored=f.make(saved),item=await restored.refreshReference(AbortSignal.timeout(5000));if(!item)throw new TypeError('Missing unavailable packet');const unavailable=packet(item);expect(unavailable.context).toBeNull();expect(unavailable.coverage.unavailable_context_ids).toHaveLength(4);expect(unavailable.selection.uncertain).toBe(true);
  f.flags.outage=false;f.flags.sourceChanged=true;const changed=await f.make(saved).refreshReference(AbortSignal.timeout(5000));if(!changed)throw new TypeError('Missing changed packet');expect(packet(changed).alternatives).toEqual([]);expect(packet(changed).context).toBeNull();
 }finally{await f.close();}
});

test('uncertain null route creates only a provisional primary while retaining existing candidate evidence',async()=>{
 const f=await fixture();try{
  f.flags.nullRoute=true;const controller=f.make(),result=packet(await controller.select(f.source.message_id,AbortSignal.timeout(5000)));if(!result.context)throw new TypeError('Missing provisional primary');
  expect(result.context?.context_id).not.toBe(f.head.context_id);expect(result.alternatives.map(item=>item.context_id)).toEqual(f.contexts.slice(0,3).map(item=>item.context_id));
  expect(result.selection).toEqual({status:'provisional',uncertain:true});expect(f.links).toHaveLength(1);expect(f.links[0]?.choice.kind).toBe('new');expect(controller.checkpoint().fresh_sources?.map(item=>item.context_id)).toEqual([result.context.context_id]);
 }finally{await f.close();}
});

test('bounded references retain the opening user-assistant round when no query windows outrank it',()=>{
 const value=context(),first=value.recent_messages[0],second=value.recent_messages[1];if(!first||!second)throw new TypeError('Missing opening round');
 second.role='assistant';value.retrieval={note_ids:[],source_windows:[]};
 const result=semanticReference({message_id:crypto.randomUUID(),primary:value,alternatives:[],selection:{status:'confirmed',uncertain:false}});
 expect(result.context?.recent_messages.map(source=>source.message_id)).toContain(first.message_id);expect(result.context?.recent_messages.map(source=>source.message_id)).toContain(second.message_id);expect(result.context).toEqual(value);
});

test('adaptive packing preserves the entire validated primary when it fits beside minimum alternate evidence',()=>{
 const primary=context(),alternatives=Array.from({length:3},()=>context());
 for(const source of primary.recent_messages)source.content=`${source.content}\n${'x'.repeat(3100)}\nexact executable /opt/example/launch --stdio`;
 const before=structuredClone(primary);
 const result=semanticReference({message_id:crypto.randomUUID(),primary,alternatives,selection:{status:'confirmed',uncertain:false}});
 expect(result.context).toEqual(before);
 expect(result.alternatives).toHaveLength(3);expect(result.alternatives.every(item=>item.notes.length+item.recent_messages.length>0)).toBe(true);
 expect(new TextEncoder().encode(JSON.stringify(result)).byteLength).toBeLessThanOrEqual(SEMANTIC_REFERENCE_MAX_BYTES);expect(primary).toEqual(before);
});
test('oversized primary balances query evidence with non-hit latest outcome and raw evidence sharing a note source',()=>{
 const primary=context(),opening=primary.recent_messages[0],latest=primary.recent_messages.at(-1),middle=primary.recent_messages[2];if(!opening||!latest||!middle)throw new TypeError('Missing evidence lanes');
 opening.content_offset=10000;opening.content='🧩'.repeat(40000);latest.role='assistant';latest.content='Completed configuration: /opt/example/worker --transport stdio';middle.content='Query source exact identifier: Example:Revision:7';
 primary.retrieval.source_windows=primary.recent_messages.slice(1,4).map(source=>({message_id:source.message_id,start:0,end:source.content.length}));
 const result=semanticReference({message_id:crypto.randomUUID(),primary,alternatives:Array.from({length:3},()=>context()),selection:{status:'provisional',uncertain:true}});
 expect(result.context?.recent_messages.find(source=>source.message_id===latest.message_id)?.content).toBe(latest.content);
 expect(result.context?.recent_messages.find(source=>source.message_id===middle.message_id)?.content).toBe(middle.content);
 expect(result.context?.notes.some(note=>note.evidence.some(evidence=>evidence.message_id===middle.message_id))).toBe(true);
 expect(result.context?.recent_messages.find(source=>source.message_id===opening.message_id)?.truncated).toBe(true);
 for(const source of result.context?.recent_messages??[]){const original=primary.recent_messages.find(item=>item.message_id===source.message_id);if(!original)throw new TypeError('Unknown source escaped packing');const {content,truncated:_cut,...provenance}=source;const {content:raw,truncated:_originalCut,...originalProvenance}=original;expect(provenance).toEqual(originalProvenance);expect(raw.startsWith(content)).toBe(true);expect(content.isWellFormed()).toBe(true);}
 expect(new TextEncoder().encode(JSON.stringify(result)).byteLength).toBeLessThanOrEqual(SEMANTIC_REFERENCE_MAX_BYTES);
});

test('large exact note-only alternatives retain a minimum evidence unit instead of silently disappearing',()=>{
 const primary=context(),alternatives=Array.from({length:3},()=>context());
 for(const source of primary.recent_messages)source.content='x'.repeat(5000);
 for(const alternate of alternatives){const note=alternate.notes[0];if(!note)throw new TypeError('Missing note');note.text='界'.repeat(1200);note.evidence=[{message_id:note.source_message_id,quote:'界'.repeat(1000)}];alternate.notes=[note];alternate.recent_messages=[];alternate.files=[];alternate.retrieval={note_ids:[note.id],source_windows:[]};}
 const result=semanticReference({message_id:crypto.randomUUID(),primary,alternatives,selection:{status:'confirmed',uncertain:false}});
 expect(result.alternatives.map(item=>item.notes)).toEqual(alternatives.map(item=>item.notes));
 expect(new TextEncoder().encode(JSON.stringify(result)).byteLength).toBeLessThanOrEqual(SEMANTIC_REFERENCE_MAX_BYTES);
});
