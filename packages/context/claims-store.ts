import { z } from 'zod';
import { hashToken, type Principal } from '../../services/control/auth';
import type { Database, Query } from '../../services/control/db';
import { DomainError } from '../protocol';
import { ownedScope, rawSource, referenceSource, retentionAllowed, type ContextScope, RawSource } from './store-read';
import { Claim, ClaimCreation, ClaimTransition, ClaimsReadRequest, ClaimsRequest, ClaimSpan } from './claims-schema';
import { resolveClaimQuote, nextClaimStatus, terminalClaim, type ClaimEvidence } from './claims-extraction';
import { StructureBM25 } from './structure-bm25';
import { sourceBatch } from './source-batch';
import { pendingRetention } from './store-retention';

const Result=z.object({created:z.array(z.uuid()),transitioned:z.array(z.uuid()),quarantine:z.array(z.object({category:z.enum(['claim','update','batch']),item:z.number(),reason:z.string()}))});
function fail(code:string):never{throw new DomainError(code,code,409);}
type Source=z.infer<typeof RawSource>;
type Span=z.infer<typeof ClaimSpan>;
async function scopeFor(tx:Query,principal:Principal,run:string,lock=false){const owned=await ownedScope(tx,principal,run,lock,'backfill');return {workspace:principal.workspace_id,conversation:owned.conversation_id,task_id:owned.task_id};}
async function retained(tx:Query,scope:ContextScope,source:Source){
 if(await retentionAllowed(tx,scope,source))return;
 const suppressed=(await tx`SELECT 1 FROM assistant.memory_suppressions WHERE workspace_id=${scope.workspace} AND source_message_id=${source.message_id}`)[0];
 if(!suppressed&&(await pendingRetention(tx,scope,source)).sources.length)fail('claim_retention_pending');
 fail('retention_denied');
}
async function snapshot(tx:Query,scope:ContextScope,source:Source){
 await tx`SELECT id FROM assistant.messages WHERE workspace_id=${scope.workspace} AND id=${source.message_id} FOR SHARE`;
 const hash=await hashToken(JSON.stringify(source));
 if(await hashToken(JSON.stringify(await referenceSource(tx,scope,source.message_id)))!==hash)fail('stale_source');
 await tx`INSERT INTO assistant.semantic_context_sources(workspace_id,conversation_id,message_id,sha256,snapshot) SELECT ${scope.workspace},conversation_id,${source.message_id},${hash},${JSON.stringify(source)}::text::jsonb FROM assistant.messages WHERE workspace_id=${scope.workspace} AND id=${source.message_id} ON CONFLICT DO NOTHING`;
 return hash;
}
async function resolve(tx:Query,scope:ContextScope,e:z.infer<typeof ClaimEvidence>,sequence:number):Promise<Span>{
 const source=await referenceSource(tx,scope,e.message_id);if(source.sequence>sequence)fail('claim_future_evidence');await retained(tx,scope,source);
 const span=resolveClaimQuote(source.content,e.quote);return {...span,message_id:source.message_id,source_sha256:await hashToken(JSON.stringify(source))};
}
async function saveEvidence(tx:Query,scope:ContextScope,id:string,revision:number,entries:{purpose:string;span:Span}[]){
 for(const [ordinal,{purpose,span:s}] of entries.entries()){
  const source=await referenceSource(tx,scope,s.message_id);
  if(await snapshot(tx,scope,source)!==s.source_sha256||source.content.slice(s.start,s.end)!==s.quote)fail('stale_source');
  await tx`INSERT INTO assistant.semantic_claim_evidence(workspace_id,claim_id,claim_revision,ordinal,purpose,message_id,source_sha256,start_utf16,end_utf16,quote,requested_quote,resolution) VALUES(${scope.workspace},${id},${revision},${ordinal},${purpose},${s.message_id},${s.source_sha256},${s.start},${s.end},${s.quote},${s.requested_quote??null},${s.resolution??null})`;
 }
}
async function heads(tx:Query,scope:ContextScope,before:number,limit:number,chain:readonly string[]=[],lane:'conversation'|'chain'|'terminal'='conversation'){
 return z.array(Claim).parse(await tx`SELECT c.*,jsonb_build_object('message_id',e.message_id,'source_sha256',e.source_sha256,'start',e.start_utf16,'end',e.end_utf16,'quote',e.quote) evidence FROM assistant.semantic_claims c JOIN assistant.semantic_claim_evidence e ON e.workspace_id=c.workspace_id AND e.claim_id=c.id AND e.claim_revision=1 AND e.purpose='origin' WHERE c.workspace_id=${scope.workspace} AND (${lane==='conversation'} AND c.conversation_id=${scope.conversation} OR ${lane==='chain'} AND c.exchange_id=ANY(${tx.array([...chain])}::uuid[]) OR ${lane==='terminal'} AND c.current_status IN ('corrected','retracted')) AND c.origin_sequence<${before} ORDER BY c.origin_sequence DESC,c.ordinal LIMIT ${limit}`);
}
async function safeHeads(tx:Query,scope:ContextScope,rows:z.infer<typeof Claim>[]){
 if(!rows.length)return [];
 const evidence=z.array(z.object({claim_id:z.uuid(),message_id:z.uuid(),source_sha256:z.string()})).parse(await tx`SELECT DISTINCT claim_id,message_id,source_sha256 FROM assistant.semantic_claim_evidence WHERE workspace_id=${scope.workspace} AND claim_id=ANY(${tx.array(rows.map(c=>c.id))}::uuid[])`);
 const sources=await sourceBatch(tx,scope,evidence.map(e=>e.message_id)),byClaim=new Map<string,typeof evidence>();
 for(const e of evidence){const list=byClaim.get(e.claim_id)??[];list.push(e);byClaim.set(e.claim_id,list);}
 return rows.filter(claim=>(byClaim.get(claim.id)??[]).every(e=>{const source=sources.get(e.message_id);return source?.retentionAllowed&&(terminalClaim(claim.current_status)||source.sha256===e.source_sha256);}));
}
async function context(tx:Query,scope:ContextScope,current:Source,limit:number){
 await retained(tx,scope,current);
 const membership=(await tx`SELECT exchange_id,kind FROM assistant.semantic_exchange_members WHERE workspace_id=${scope.workspace} AND message_id=${current.message_id}`)[0];
 const member=membership?z.object({exchange_id:z.uuid(),kind:z.string()}).parse(membership):null;
 const attribution=z.object({response_to_message_id:z.uuid().nullable(),synthetic:z.boolean()}).parse((await tx`SELECT response_to_message_id,synthetic FROM assistant.messages WHERE workspace_id=${scope.workspace} AND id=${current.message_id}`)[0]);
 if(attribution.synthetic)fail('claim_synthetic_source');
 const userExchange=(await tx`SELECT id FROM assistant.semantic_exchanges WHERE workspace_id=${scope.workspace} AND user_message_id=${current.message_id}`)[0];
 let cursor=member?.exchange_id??(userExchange?z.object({id:z.uuid()}).parse(userExchange).id:null);
 const chain:string[]=[];
 for(let hop=0;cursor&&hop<5;hop++){
  chain.push(cursor);
  const edge=(await tx`SELECT target_exchange_id FROM assistant.semantic_exchange_edges WHERE workspace_id=${scope.workspace} AND child_exchange_id=${cursor} AND role='primary' AND state='linked' AND NOT needs_revalidation AND status<>'rejected' AND relation IN ('follow_up','challenge','correction') AND anchor_confidence>=0.7`)[0];
  cursor=edge?z.object({target_exchange_id:z.uuid()}).parse(edge).target_exchange_id:null;
 }
 // Bounded source pool; lexical candidates are BM25, not topic attribution.
 const pool=await safeHeads(tx,scope,await heads(tx,scope,current.sequence,2048));
 const chainClaims=await safeHeads(tx,scope,await heads(tx,scope,current.sequence,64,chain,'chain'));
 const lexical=new StructureBM25(pool.map(c=>({id:c.id,text:c.text+' '+c.subjects.join(' ')}))).rank(current.content).slice(0,32);
 const ids=new Set([...pool.filter(c=>chain.includes(c.exchange_id)).slice(0,64).map(c=>c.id),...lexical]);
 const tombstones=await safeHeads(tx,scope,await heads(tx,scope,current.sequence,128,[],'terminal'));
 const claims=[...new Map([...chainClaims,...pool.filter(c=>ids.has(c.id))].slice(0,limit).concat(tombstones).map(c=>[c.id,c])).values()];
  const supplied:Source[]=[current];
  if(member){const row=(await tx`SELECT user_message_id FROM assistant.semantic_exchanges WHERE workspace_id=${scope.workspace} AND id=${member.exchange_id}`)[0];if(row){const user=await referenceSource(tx,scope,z.object({user_message_id:z.uuid()}).parse(row).user_message_id);if(await retentionAllowed(tx,scope,user))supplied.push(user);}}
  // Full prior assertions and the immediate retained workflow disambiguate
  // deictic objections: a login request must not challenge every login claim.
  // Keep these separate from sources authorized for new-claim basis evidence.
  const priorPool=await sourceBatch(tx,scope,claims.map(c=>c.evidence.message_id));
  const prior_sources=[...priorPool.values()].filter(s=>s.retentionAllowed).map(s=>s.raw);
  const recentIds=z.array(z.object({id:z.uuid()})).parse(await tx`SELECT id FROM assistant.messages WHERE workspace_id=${scope.workspace} AND conversation_id=${scope.conversation} AND sequence<${current.sequence} AND NOT synthetic AND role IN ('user','assistant') ORDER BY sequence DESC LIMIT 4`);
  const recentPool=await sourceBatch(tx,scope,recentIds.map(s=>s.id));
  const recent_context=[...recentPool.values()].filter(s=>s.retentionAllowed).map(s=>s.raw).toSorted((a,b)=>a.sequence-b.sequence);
  return {current,substantive:current.role==='assistant'&&member?.kind==='answer',ownership_pending:current.role==='assistant'&&!member&&!!attribution.response_to_message_id,exchange_id:member?.exchange_id??null,claims,sources:supplied,prior_sources,recent_context,exchanges:[]};
}
export async function readClaims(sql:Database,principal:Principal,run:string,input:z.input<typeof ClaimsReadRequest>){
 const request=ClaimsReadRequest.parse(input);
 const deliverySources=request.delivery_source_ids;
 if(deliverySources)return sql.begin(async tx=>{
  await tx`SET TRANSACTION ISOLATION LEVEL REPEATABLE READ READ ONLY`;
  const scope=await scopeFor(tx,principal,run),current=await rawSource(tx,scope,request.message_id);
  await retained(tx,scope,current);
  if(current.task_id!==scope.task_id||current.role!=='user')fail('claim_invalid_source');
  // Select by delivered source, not a top-K claim search: old tombstones must not
  // disappear merely because the conversation has accumulated more claims.
  const claims=z.array(Claim).parse(await tx`SELECT c.*,jsonb_build_object('message_id',e.message_id,'source_sha256',e.source_sha256,'start',e.start_utf16,'end',e.end_utf16,'quote',e.quote) evidence FROM assistant.semantic_claims c JOIN assistant.semantic_claim_evidence e ON e.workspace_id=c.workspace_id AND e.claim_id=c.id AND e.claim_revision=1 AND e.purpose='origin' WHERE c.workspace_id=${scope.workspace} AND c.conversation_id=${scope.conversation} AND e.message_id=ANY(${tx.array(deliverySources)}::uuid[]) AND c.origin_sequence<${current.sequence}`);
  // Without a finished transition pass, any preceding answer could be its target.
  // Flag only answer sources older than a missing user pass, plus unprocessed
  // answers themselves. No waiting for extraction or for the current anchor.
  const pending=z.array(z.object({id:z.uuid()})).parse(await tx`SELECT m.id FROM assistant.messages m WHERE m.workspace_id=${scope.workspace} AND m.conversation_id=${scope.conversation} AND m.id=ANY(${tx.array(deliverySources)}::uuid[]) AND m.role='assistant' AND m.sequence<${current.sequence} AND (NOT EXISTS(SELECT 1 FROM assistant.semantic_claim_operations o WHERE o.workspace_id=m.workspace_id AND o.message_id=m.id) OR EXISTS(SELECT 1 FROM assistant.messages u WHERE u.workspace_id=m.workspace_id AND u.conversation_id=m.conversation_id AND u.role='user' AND NOT u.synthetic AND u.sequence>m.sequence AND u.sequence<${current.sequence} AND NOT EXISTS(SELECT 1 FROM assistant.semantic_claim_operations o WHERE o.workspace_id=u.workspace_id AND o.message_id=u.id)))`);
  // Delivery only exposes origin evidence, not transition evidence. Forgetting a
  // correction trigger must not resurrect an otherwise retained retired answer.
  const origins=await sourceBatch(tx,scope,claims.map(c=>c.evidence.message_id));
  return {claims:claims.filter(c=>origins.get(c.evidence.message_id)?.retentionAllowed).map(c=>({current_status:c.current_status,evidence:{...c.evidence,quote:''}})),pending_message_ids:pending.map(p=>p.id)};
 });
 return sql.begin(async tx=>{await tx`SET TRANSACTION ISOLATION LEVEL REPEATABLE READ READ ONLY`;const scope=await scopeFor(tx,principal,run),current=await rawSource(tx,scope,request.message_id);if(request.prepare)await predecessorsComplete(tx,scope,current);return {...await context(tx,scope,current,request.limit),source_sha256:await hashToken(JSON.stringify(current))};});
}
/** Queue ordering requires only source identity/sequence, never source content. */
export async function readClaimMetadata(sql:Database,principal:Principal,run:string,message:string){const scope=await scopeFor(sql,principal,run),source=await rawSource(sql,scope,z.uuid().parse(message));return {sequence:source.sequence,conversation_id:scope.conversation};}
async function predecessorsComplete(tx:Query,scope:ContextScope,current:Source){
 // Fail closed across an unobserved mailbox gap before inference as well as commit.
 const predecessors=z.array(z.object({id:z.uuid()})).parse(await tx`SELECT m.id FROM assistant.messages m WHERE m.workspace_id=${scope.workspace} AND m.conversation_id=${scope.conversation} AND m.task_id=${current.task_id} AND m.sequence<${current.sequence} AND m.role IN ('user','assistant') AND NOT m.synthetic AND NOT EXISTS(SELECT 1 FROM assistant.semantic_claim_operations o WHERE o.workspace_id=m.workspace_id AND o.message_id=m.id) ORDER BY m.sequence LIMIT 257`);
 if(predecessors.length>256)fail('claim_predecessor_pending');
 const sources=await sourceBatch(tx,scope,predecessors.map(p=>p.id));
 for(const source of sources.values())if(source.retentionAllowed||(await pendingRetention(tx,scope,source.raw)).sources.length)fail('claim_predecessor_pending');
}
function reason(error:unknown){if(error instanceof DomainError)return error.code;if(error instanceof z.ZodError)return 'claim_schema_invalid';if(error instanceof Error&&/^claim_[a-z_]+$/.test(error.message))return error.message;throw error;}
export async function createClaims(sql:Database,principal:Principal,run:string,input:z.input<typeof ClaimsRequest>){
 const request=ClaimsRequest.parse(input),requestHash=await hashToken(JSON.stringify(request));
 return sql.begin(async tx=>{
  const scope=await scopeFor(tx,principal,run,true);
  await tx`SELECT pg_advisory_xact_lock(hashtextextended(${scope.workspace+':claims:'+scope.conversation},0))`;
  await tx`SELECT pg_advisory_xact_lock(hashtextextended(${scope.workspace+':semantic-structure'},0))`;
  const current=await rawSource(tx,scope,request.message_id);await retained(tx,scope,current);
  if(current.task_id!==scope.task_id||current.role==='system')fail('claim_invalid_source');
  if(await hashToken(JSON.stringify(current))!==request.source_sha256)fail('stale_source');
  const prior=(await tx`SELECT request_hash,vm_id,result FROM assistant.semantic_claim_operations WHERE workspace_id=${scope.workspace} AND message_id=${request.message_id} AND source_sha256=${request.source_sha256} AND extractor_version=${request.extractor_version}`)[0];
  if(prior){const saved=z.object({request_hash:z.string(),vm_id:z.uuid(),result:Result}).parse(prior);if(saved.request_hash!==requestHash||saved.vm_id!==principal.vm_id)fail('idempotency_conflict');return saved.result;}
  if((await tx`SELECT 1 FROM assistant.semantic_claim_operations o JOIN assistant.messages m ON m.workspace_id=o.workspace_id AND m.id=o.message_id WHERE o.workspace_id=${scope.workspace} AND m.conversation_id=${scope.conversation} AND m.sequence>=${current.sequence} LIMIT 1`)[0])fail('claim_out_of_order');
  // An earlier persisted source can reach the local mailbox after this job. Do not
  // commit past that gap merely because SQLite received the later event first.
  await predecessorsComplete(tx,scope,current);
  const corpus=await context(tx,scope,current,128),available=new Map(corpus.claims.map(c=>[c.id,c]));
  const result:z.infer<typeof Result>={created:[],transitioned:[],quarantine:request.quarantine_reason?[{category:'batch',item:0,reason:request.quarantine_reason}]:[]};
  const updates:{claim:z.infer<typeof Claim>;request:z.infer<typeof ClaimTransition>;to:z.infer<typeof Claim>['current_status'];target:Span;trigger:Span}[]=[];
  const seen=new Set<string>();
  for(const [i,item] of request.updates.entries())try{
   const u=ClaimTransition.parse(item),claim=available.get(u.claim_id);if(!claim||seen.has(u.claim_id))fail('claim_invalid_target');
   if(claim.revision!==u.expected_revision)fail('stale_revision');
   const history=z.object({trigger_sequence:z.coerce.number()}).parse((await tx`SELECT trigger_sequence FROM assistant.semantic_claim_revisions WHERE workspace_id=${scope.workspace} AND claim_id=${claim.id} AND revision=${claim.revision}`)[0]);
   if(history.trigger_sequence>=current.sequence)fail('claim_out_of_order');
   if(u.evidence.message_id!==current.message_id)fail('claim_trigger_not_current');
    const to=nextClaimStatus(claim.current_status,u.action,u.interpretation,current.role),target=await resolve(tx,scope,u.prior_evidence,current.sequence-1),trigger=await resolve(tx,scope,u.evidence,current.sequence);
    if(target.message_id!==claim.evidence.message_id||target.start!==claim.evidence.start||target.end!==claim.evidence.end||u.prior_evidence.quote!==claim.evidence.quote)fail('claim_prior_not_full');
    if(trigger.resolution)fail('claim_trigger_not_verbatim');
   updates.push({claim,request:u,to,target,trigger});seen.add(claim.id);
  }catch(error){if(error instanceof DomainError&&error.code==='stale_revision')throw error;result.quarantine.push({category:'update',item:i,reason:reason(error)});}
  const drafts:{draft:z.infer<typeof ClaimCreation>;origin:Span;basis:Span[];time:Span|null}[]=[];
  const ordinals=new Set<number>();
  for(const [i,item] of request.claims.entries())try{
   const d=ClaimCreation.parse(item);if(ordinals.has(d.ordinal))fail('claim_duplicate_ordinal');ordinals.add(d.ordinal);
   if(!corpus.substantive||!corpus.exchange_id)fail('claim_missing_substantive_exchange');
   if(d.evidence.message_id!==current.message_id)fail('claim_origin_not_current');
   const origin=await resolve(tx,scope,d.evidence,current.sequence);
   const supplied=async(e:z.infer<typeof ClaimEvidence>)=>{if(!corpus.sources.some(s=>s.message_id===e.message_id))fail('claim_evidence_not_supplied');return resolve(tx,scope,e,current.sequence);};
   const basis=await Promise.all(d.basis_evidence.map(supplied));
   if(d.basis==='reported'&&(!basis.length||basis.some(e=>corpus.sources.find(s=>s.message_id===e.message_id)?.role!=='user')))fail('claim_report_without_user');
   if(d.basis==='sourced'&&(!d.citations.length||d.citations.some(c=>!corpus.sources.some(s=>(s.message_id===current.message_id||basis.some(e=>e.message_id===s.message_id))&&s.content.includes(c)))))fail('claim_missing_citation');
   const time=d.valid_time_evidence?await supplied(d.valid_time_evidence):null;
   if((d.valid_from||d.valid_to)&&!time)fail('claim_missing_time_evidence');
   if(d.valid_from&&d.valid_to&&Date.parse(d.valid_from)>=Date.parse(d.valid_to))fail('claim_invalid_interval');
   if(d.supersedes.some(id=>!updates.some(u=>u.claim.id===id&&terminalClaim(u.to))))fail('claim_unjustified_supersession');
   if(d.blocked_by.length||corpus.claims.some(c=>(terminalClaim(c.current_status)||updates.some(u=>u.claim.id===c.id&&terminalClaim(u.to)))&&c.text.normalize('NFC').replace(/\s+/gu,' ').trim()===d.text.normalize('NFC').replace(/\s+/gu,' ').trim()))fail('claim_tombstone_blocked');
   drafts.push({draft:d,origin,basis,time});
  }catch(error){result.quarantine.push({category:'claim',item:i,reason:reason(error)});}
  await snapshot(tx,scope,current);
  for(const u of updates){
   const revision=u.claim.revision+1;
   const changed=await tx`UPDATE assistant.semantic_claims SET revision=${revision},current_status=${u.to} WHERE workspace_id=${scope.workspace} AND id=${u.claim.id} AND revision=${u.request.expected_revision} RETURNING id`;if(!changed.length)fail('stale_revision');
   await tx`INSERT INTO assistant.semantic_claim_revisions(workspace_id,claim_id,revision,previous_revision,from_status,to_status,action,trigger_message_id,trigger_sequence,actor_role,request_sha256,model_version,reason,interpretation) VALUES(${scope.workspace},${u.claim.id},${revision},${u.claim.revision},${u.claim.current_status},${u.to},${u.request.action},${current.message_id},${current.sequence},${current.role},${request.request_sha256},${request.provider_model},${u.request.action},${u.request.interpretation})`;
   await saveEvidence(tx,scope,u.claim.id,revision,[{purpose:'transition_target',span:u.target},{purpose:'transition_trigger',span:u.trigger}]);result.transitioned.push(u.claim.id);
  }
  const link=(await tx`SELECT context_id FROM assistant.semantic_context_links WHERE workspace_id=${scope.workspace} AND message_id=${current.message_id}`)[0];const contextId=link?z.object({context_id:z.uuid()}).parse(link).context_id:null;
  for(const {draft:d,origin,basis,time} of drafts){
   const row=(await tx`INSERT INTO assistant.semantic_claims(workspace_id,conversation_id,exchange_id,context_id,origin_message_id,origin_source_sha256,origin_sequence,text,subjects,kind,basis,valid_from,valid_to,extractor_version,ordinal,provider_model,prompt_sha256,schema_version,request_sha256) VALUES(${scope.workspace},${scope.conversation},${corpus.exchange_id},${contextId},${current.message_id},${request.source_sha256},${current.sequence},${d.text},${JSON.stringify(d.subjects)}::text::jsonb,${d.kind},${d.basis},${d.valid_from},${d.valid_to},${request.extractor_version},${d.ordinal},${request.provider_model},${request.prompt_sha256},${request.schema_version},${request.request_sha256}) RETURNING id`)[0];
   const id=z.object({id:z.uuid()}).parse(row).id;
   await tx`INSERT INTO assistant.semantic_claim_revisions(workspace_id,claim_id,revision,to_status,action,trigger_message_id,trigger_sequence,actor_role,request_sha256,model_version,reason) VALUES(${scope.workspace},${id},1,'active','create',${current.message_id},${current.sequence},'assistant',${request.request_sha256},${request.provider_model},'assistant_report')`;
   await saveEvidence(tx,scope,id,1,[{purpose:'origin',span:origin},...basis.map(span=>({purpose:'basis',span})),...(time?[{purpose:'effective_time',span:time}]:[])]);
   for(const old of new Set(d.supersedes)){const u=updates.find(u=>u.claim.id===old)!;await tx`INSERT INTO assistant.semantic_claim_supersessions(workspace_id,old_claim_id,new_claim_id,revision_id) VALUES(${scope.workspace},${old},${id},${u.claim.revision+1})`;}
   result.created.push(id);
  }
  await tx`INSERT INTO assistant.semantic_claim_operations(workspace_id,message_id,source_sha256,extractor_version,request_hash,vm_id,result) VALUES(${scope.workspace},${current.message_id},${request.source_sha256},${request.extractor_version},${requestHash},${principal.vm_id},${JSON.stringify(result)}::text::jsonb)`;
  return result;
 });
}
export async function transitionClaim(sql:Database,principal:Principal,run:string,input:z.input<typeof ClaimsRequest>){const request=ClaimsRequest.parse(input);if(request.claims.length)fail('claim_transition_only');return createClaims(sql,principal,run,request);}
