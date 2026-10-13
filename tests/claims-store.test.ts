import { afterAll, expect, test } from 'bun:test';
import { createDatabase } from '../services/control/db';
import { createApp } from '../services/control/app';
import { hashToken, type Principal } from '../services/control/auth';
import { rawSource } from '../packages/context/store-read';
import { ensureExchange, attributeMember } from '../packages/context/structure-store';
import { createClaims, readClaims, transitionClaim } from '../packages/context/claims-store';
import { CLAIM_PROMPT, ClaimDraft, nextClaimStatus, resolveClaimQuote } from '../packages/context/claims-extraction';
import { filterRetiredClaims, tombstoneFilter } from '../packages/context/claims-packet';
import type { z } from 'zod';

const sql=createDatabase(process.env['TEST_DATABASE_URL']??'postgres://assistant:assistant@127.0.0.1:55439/assistant_test');
afterAll(()=>sql.end());
async function fixture(){
 const workspace=crypto.randomUUID(),conversation=crypto.randomUUID(),vm=crypto.randomUUID(),task=crypto.randomUUID(),run=crypto.randomUUID();
 await sql`INSERT INTO assistant.workspaces(id,name) VALUES(${workspace},'claims QA')`;
 await sql`INSERT INTO assistant.conversations(id,workspace_id,title) VALUES(${conversation},${workspace},'claims')`;
 await sql`INSERT INTO assistant.vms(id,workspace_id,name) VALUES(${vm},${workspace},'claims VM')`;
 await sql`INSERT INTO assistant.tasks(id,workspace_id,conversation_id,objective,state) VALUES(${task},${workspace},${conversation},'claims','running')`;
 await sql`INSERT INTO assistant.runs(id,workspace_id,task_id,vm_id) VALUES(${run},${workspace},${task},${vm})`;
 const principal:Principal={workspace_id:workspace,role:'vm',vm_id:vm},actor={principal,run};
 async function message(content:string,role:'user'|'assistant'='user',response:string|null=null){
  const id=crypto.randomUUID();await sql`INSERT INTO assistant.messages(id,workspace_id,conversation_id,task_id,role,content,response_to_message_id,output_kind) VALUES(${id},${workspace},${conversation},${task},${role},${content},${response},${role==='assistant'?'answer':null})`;
  if(role==='user'){await sql`INSERT INTO assistant.memory_retention_decisions(workspace_id,task_id,source_message_id,action) VALUES(${workspace},${task},${id},'inherit')`;await ensureExchange(sql,actor,id);}
  if(role==='assistant'&&response)await attributeMember(sql,actor,{message_id:id,response_to_message_id:response,kind:'answer',method:'response_to'});
  return id;
 }
 async function request(message_id:string,claims:unknown[]=[],updates:unknown[]=[]){return {message_id,source_sha256:await hashToken(JSON.stringify(await rawSource(sql,{workspace,conversation},message_id))),extractor_version:'1',provider_model:'mock',prompt_sha256:await hashToken(CLAIM_PROMPT),schema_version:'1',request_sha256:await hashToken(JSON.stringify({message_id,claims,updates})),claims,updates};}
 const user=await message('주장 검토 요청');
 await createClaims(sql,principal,run,await request(user));
 const answer=await message('한국어 **정확한 주장**은 3개입니다.','assistant',user);
 const draft:z.infer<typeof ClaimDraft>&{ordinal:number}={ordinal:0,text:'한국어 정확한 주장은 3개입니다.',subjects:['한국어 주장'],kind:'number',basis:'inferred',evidence:{message_id:answer,quote:'한국어 **정확한 주장**은 3개입니다.'},basis_evidence:[],citations:[],valid_from:null,valid_to:null,valid_time_evidence:null,supersedes:[],blocked_by:[]};
 return {workspace,conversation,principal,run,user,answer,message,request,draft};
}
test('claim exact, normalized-unique and ambiguous quote resolution preserves raw Korean UTF-16',()=>{
 expect(resolveClaimQuote('😀 한국어 **원문**은 3개','한국어 원문은 3개')).toMatchObject({start:3,quote:'한국어 **원문**은 3개',resolution:'normalized'});
 expect(resolveClaimQuote('가'.normalize('NFD'),'가').quote).toBe('가'.normalize('NFD'));
 expect(()=>resolveClaimQuote('“값” 그리고 “값”','"값"')).toThrow('claim_ambiguous_quote');
 expect(()=>resolveClaimQuote('값 값','값')).toThrow('claim_ambiguous_quote');
 expect(()=>resolveClaimQuote('3개가 아닙니다','4개가 아닙니다')).toThrow();
 expect(()=>resolveClaimQuote('허용하지 않습니다','허용합니다')).toThrow();
});
test('claim lifecycle preserves misreading, requires challenge for reaffirmation and never reverts terminal',()=>{
 expect(nextClaimStatus('active','misreading','사용자의 오독')).toBe('active');
 expect(nextClaimStatus('challenged','misreading','오독')).toBe('reaffirmed');
 expect(nextClaimStatus('active','correct',null)).toBe('corrected');
 expect(()=>nextClaimStatus('active','reaffirm',null)).toThrow();
 for(const status of ['corrected','retracted'] as const)for(const action of ['reaffirm','misreading','challenge','correct','retract'] as const)expect(()=>nextClaimStatus(status,action,'오독')).toThrow('claim_terminal');
});
test('batch creation is concurrent-idempotent; invalid siblings quarantined and provenance remains a report',async()=>{
 const f=await fixture(),request=await f.request(f.answer,[f.draft,{...f.draft,ordinal:1,evidence:{message_id:f.answer,quote:'발명된 문장'}}]);
 const [a,b]=await Promise.all([createClaims(sql,f.principal,f.run,request),createClaims(sql,f.principal,f.run,request)]);
 expect(a).toEqual(b);expect(a.created).toHaveLength(1);expect(a.quarantine).toEqual([{category:'claim',item:1,reason:'claim_invalid_quote'}]);
 const next=await f.message('검증해주세요'),read=await readClaims(sql,f.principal,f.run,{message_id:next});
 expect(read.claims[0]).toMatchObject({epistemic:'assistant_report',revision:1,text:f.draft.text,evidence:{quote:f.draft.evidence.quote}});
 expect(await sql`SELECT * FROM assistant.semantic_claim_revisions WHERE workspace_id=${f.workspace}`).toHaveLength(1);
 await expect(createClaims(sql,f.principal,f.run,{...request,provider_model:'different'})).rejects.toThrow('idempotency_conflict');
});
test('user correction, CAS conflict, self-correction, rejected update cannot authorize replacement',async()=>{
 const f=await fixture(),created=await createClaims(sql,f.principal,f.run,await f.request(f.answer,[f.draft]));
 const trigger=await f.message('3개가 아니라 4개입니다.'),update={claim_id:created.created[0]!,expected_revision:2,action:'correct',prior_evidence:f.draft.evidence,evidence:{message_id:trigger,quote:'3개가 아니라 4개입니다.'},interpretation:null};
 await expect(transitionClaim(sql,f.principal,f.run,await f.request(trigger,[],[update]))).rejects.toThrow('stale_revision');
 const request=await f.request(trigger,[],[{...update,expected_revision:1}]),changed=await transitionClaim(sql,f.principal,f.run,request);expect(changed.transitioned).toEqual(created.created);expect(await transitionClaim(sql,f.principal,f.run,request)).toEqual(changed);
 const later=await f.message('이전 설명은 맞습니다.','assistant',trigger);
 const terminal=await createClaims(sql,f.principal,f.run,await f.request(later,[],[{...update,expected_revision:2,action:'reaffirm',evidence:{message_id:later,quote:'이전 설명은 맞습니다.'}}]));expect(terminal.quarantine[0]?.reason).toBe('claim_terminal');
 const read=await readClaims(sql,f.principal,f.run,{message_id:later});expect(read.claims[0]?.current_status).toBe('corrected');
 await expect(sql`UPDATE assistant.semantic_claims SET current_status='active' WHERE workspace_id=${f.workspace}`.execute()).rejects.toThrow();
 const g=await fixture(),old=await createClaims(sql,g.principal,g.run,await g.request(g.answer,[g.draft]));
 const correction=await g.message('제가 잘못 설명했습니다. 4개입니다.','assistant',g.user);
 const replacement={...g.draft,evidence:{message_id:correction,quote:'4개입니다.'},text:'4개입니다.',supersedes:old.created};
  const fixed=await createClaims(sql,g.principal,g.run,await g.request(correction,[replacement],[{claim_id:old.created[0],expected_revision:1,action:'correct',prior_evidence:g.draft.evidence,evidence:{message_id:correction,quote:'제가 잘못 설명했습니다. 4개입니다.'},interpretation:null}]));
 expect(fixed.created).toHaveLength(1);expect(fixed.transitioned).toHaveLength(1);expect(await sql`SELECT * FROM assistant.semantic_claim_supersessions WHERE workspace_id=${g.workspace}`).toHaveLength(1);
 const h=await fixture(),base=await createClaims(sql,h.principal,h.run,await h.request(h.answer,[h.draft])),bad=await h.message('4개입니다.','assistant',h.user);
 const rejected=await createClaims(sql,h.principal,h.run,await h.request(bad,[{...h.draft,text:'4개입니다.',evidence:{message_id:bad,quote:'4개입니다.'},supersedes:base.created}],[{claim_id:base.created[0],expected_revision:1,action:'correct',prior_evidence:h.draft.evidence,evidence:{message_id:h.answer,quote:h.draft.evidence.quote},interpretation:null}]));
 expect(rejected.created).toEqual([]);expect(rejected.transitioned).toEqual([]);expect(rejected.quarantine).toHaveLength(2);
});
test('misreading event keeps claim active; challenge then explicit resolution reaffirms',async()=>{
 const f=await fixture(),created=await createClaims(sql,f.principal,f.run,await f.request(f.answer,[f.draft]));
 const trigger=await f.message('그 뜻이 아닙니다.','assistant',f.user),u={claim_id:created.created[0]!,expected_revision:1,action:'misreading',prior_evidence:f.draft.evidence,evidence:{message_id:trigger,quote:'그 뜻이 아닙니다.'},interpretation:'잘못된 사용자 해석'};
 expect((await transitionClaim(sql,f.principal,f.run,await f.request(trigger,[],[u]))).transitioned).toHaveLength(1);
 const challenge=await f.message('검증 필요');expect((await readClaims(sql,f.principal,f.run,{message_id:challenge})).claims[0]?.current_status).toBe('active');
  await transitionClaim(sql,f.principal,f.run,await f.request(challenge,[],[{...u,expected_revision:2,action:'challenge',interpretation:null,evidence:{message_id:challenge,quote:'검증 필요'}}]));
 const rebuttal=await f.message('기존 주장을 확인했습니다.','assistant',challenge);
  await transitionClaim(sql,f.principal,f.run,await f.request(rebuttal,[],[{...u,expected_revision:3,action:'reaffirm',interpretation:null,evidence:{message_id:rebuttal,quote:'기존 주장을 확인했습니다.'}}]));
 expect((await readClaims(sql,f.principal,f.run,{message_id:rebuttal})).claims[0]).toMatchObject({current_status:'reaffirmed',revision:4});
});
test('workspace isolation and denied source cannot be read or replayed',async()=>{
 const f=await fixture(),other=await fixture(),request=await f.request(f.answer,[f.draft]);await createClaims(sql,f.principal,f.run,request);
 await expect(readClaims(sql,other.principal,f.run,{message_id:f.answer})).rejects.toThrow();
 await expect(createClaims(sql,other.principal,other.run,request)).rejects.toThrow();
 const next=await other.message('한국어 주장');expect((await readClaims(sql,other.principal,other.run,{message_id:next})).claims).toEqual([]);
 await sql`INSERT INTO assistant.memory_suppressions(workspace_id,source_message_id) VALUES(${f.workspace},${f.answer})`;
 await expect(createClaims(sql,f.principal,f.run,request)).rejects.toThrow('retention_denied');
});
test('transition target must quote whole evidence; normalized trigger and wrong speaker are quarantined',async()=>{
 const f=await fixture(),created=await createClaims(sql,f.principal,f.run,await f.request(f.answer,[f.draft]));
 const trigger=await f.message('그 해석은 **틀립니다**.','user');
 const update={claim_id:created.created[0]!,expected_revision:1,action:'correct',prior_evidence:f.draft.evidence,evidence:{message_id:trigger,quote:'그 해석은 **틀립니다**.'},interpretation:null};
 const result=await transitionClaim(sql,f.principal,f.run,await f.request(trigger,[],[
  {...update,prior_evidence:{message_id:f.answer,quote:'3개입니다.'}},
  {...update,evidence:{message_id:trigger,quote:'그 해석은 틀립니다.'}},
  {...update,action:'misreading',interpretation:'사용자의 오독'},
  {...update,action:'reaffirm'},
 ]));
 expect(result.transitioned).toEqual([]);
 expect(result.quarantine.map(q=>q.reason)).toEqual(['claim_prior_not_full','claim_trigger_not_verbatim','claim_invalid_transition_role','claim_invalid_transition_role']);
 const assistant=await f.message('3개라는 주장에 의문이 있습니다.','assistant',trigger);
 const rejected=await transitionClaim(sql,f.principal,f.run,await f.request(assistant,[],[{...update,action:'challenge',evidence:{message_id:assistant,quote:'3개라는 주장에 의문이 있습니다.'}}]));
 expect(rejected.quarantine[0]?.reason).toBe('claim_invalid_transition_role');
 expect((await readClaims(sql,f.principal,f.run,{message_id:assistant})).claims[0]?.current_status).toBe('active');
});
test('transition context carries full retained prior assertions and recent workflow, never denied sources',async()=>{
 const f=await fixture();await createClaims(sql,f.principal,f.run,await f.request(f.answer,[f.draft]));
 const trigger=await f.message('이 주장의 근거가 뭔가요?');
 const corpus=await readClaims(sql,f.principal,f.run,{message_id:trigger});
 expect('prior_sources' in corpus&&corpus.prior_sources.map(s=>s.message_id)).toContain(f.answer);
 expect('recent_context' in corpus&&corpus.recent_context.map(s=>s.message_id)).toEqual([f.user,f.answer]);
 if('prior_sources' in corpus)expect(corpus.prior_sources.find(s=>s.message_id===f.answer)?.content).toBe(f.draft.evidence.quote);
 await sql`INSERT INTO assistant.memory_suppressions(workspace_id,source_message_id) VALUES(${f.workspace},${f.answer})`;
 const filtered=await readClaims(sql,f.principal,f.run,{message_id:trigger});
 expect('prior_sources' in filtered&&filtered.prior_sources.map(s=>s.message_id)).not.toContain(f.answer);
 expect('recent_context' in filtered&&filtered.recent_context.map(s=>s.message_id)).not.toContain(f.answer);
});
test('tombstone filter drops overlapping windows without mutating the shadow packet',()=>{
 const span={message_id:crypto.randomUUID(),sha256:'a'.repeat(64),start:0,end:20,quote:'retired origin text'};
 const ledger=[{current_status:'corrected',evidence:{...span,source_sha256:span.sha256,start:5,end:12}}],packet={items:[{answers:[span,{...span,start:20,end:30}]}]},original=JSON.stringify(packet);
 expect(tombstoneFilter(['retired origin text','unrelated'],ledger)).toEqual([0]);
 const filtered=filterRetiredClaims(packet,ledger);expect(filtered.redacted).toBe(1);expect(filtered.packet.items[0]?.answers).toHaveLength(1);expect(JSON.stringify(packet)).toBe(original);
 expect(tombstoneFilter([{...span,sha256:'b'.repeat(64)}],ledger)).toEqual([0]);
});
test('normalized quote audit is persisted; reported basis and dates require supplied evidence',async()=>{
 const f=await fixture();
 const result=await createClaims(sql,f.principal,f.run,await f.request(f.answer,[
  {...f.draft,evidence:{message_id:f.answer,quote:'한국어 정확한 주장은 3개입니다.'}},
  {...f.draft,ordinal:1,basis:'reported'},
  {...f.draft,ordinal:2,valid_from:'2026-01-01T00:00:00Z'},
  {...f.draft,ordinal:3,basis:'sourced',citations:['https://invented.invalid']},
 ]));
 expect(result.created).toHaveLength(1);expect(result.quarantine.map(q=>q.reason)).toEqual(['claim_report_without_user','claim_missing_time_evidence','claim_missing_citation']);
 const evidence=await sql`SELECT quote,requested_quote,resolution,verification_status FROM assistant.semantic_claim_evidence WHERE workspace_id=${f.workspace}`;
 expect(evidence[0]).toEqual({quote:f.draft.evidence.quote,requested_quote:'한국어 정확한 주장은 3개입니다.',resolution:'normalized',verification_status:'unverified'});
 await expect(sql`UPDATE assistant.semantic_claim_evidence SET quote='invented' WHERE workspace_id=${f.workspace}`.execute()).rejects.toThrow();
});
test('run-scoped claim routes authenticate and retain model-independent validation',async()=>{
 const f=await fixture(),app=createApp(sql),token=crypto.randomUUID()+crypto.randomUUID(),clientToken=crypto.randomUUID()+crypto.randomUUID();
 await sql`INSERT INTO assistant.credentials(token_hash,workspace_id,role,vm_id) VALUES(${await hashToken(token)},${f.workspace},'vm',${f.principal.vm_id}),(${await hashToken(clientToken)},${f.workspace},'client',NULL)`;
 const call=(suffix:string,body:unknown,bearer:string|null=token)=>app.request(`/v1/daemon/context/${f.run}/claims${suffix}`,{method:'POST',headers:{'Content-Type':'application/json',...(bearer?{Authorization:`Bearer ${bearer}`}:{})},body:JSON.stringify(body)});
 expect((await call('/read',{message_id:f.answer},null)).status).toBe(401);
 expect((await call('/read',{message_id:f.answer},clientToken)).status).toBe(403);
 expect((await call('/read',{message_id:'invalid'})).status).toBe(400);
 expect((await call('/read',{message_id:f.answer})).status).toBe(200);
 expect((await call('',await f.request(f.answer,[f.draft]))).status).toBe(200);
 const other=await fixture();expect((await call('/read',{message_id:other.answer})).status).toBe(409);
});
test('pending retention and earlier source gaps are retryable, never silently skipped',async()=>{
 const f=await fixture();
 await sql`DELETE FROM assistant.memory_retention_decisions WHERE workspace_id=${f.workspace} AND source_message_id=${f.user}`;
 await expect(readClaims(sql,f.principal,f.run,{message_id:f.answer})).rejects.toThrow('claim_retention_pending');
 await sql`INSERT INTO assistant.memory_retention_decisions(workspace_id,task_id,source_message_id,action) SELECT workspace_id,task_id,id,'inherit' FROM assistant.messages WHERE workspace_id=${f.workspace} AND id=${f.user}`;
 const later=await f.message('나중 사용자 메시지');
 await expect(createClaims(sql,f.principal,f.run,await f.request(later))).rejects.toThrow('claim_predecessor_pending');
 await createClaims(sql,f.principal,f.run,await f.request(f.answer,[f.draft]));
 expect((await createClaims(sql,f.principal,f.run,await f.request(later))).quarantine).toEqual([]);
});
test('claims retain workspace-wide semantic ownership across conversations, not workspaces',async()=>{
 const f=await fixture(),conversation=crypto.randomUUID(),context=crypto.randomUUID(),source=crypto.randomUUID();
 await sql`INSERT INTO assistant.conversations(id,workspace_id,title) VALUES(${conversation},${f.workspace},'other context origin')`;
 await sql`INSERT INTO assistant.messages(id,workspace_id,conversation_id,role,content) VALUES(${source},${f.workspace},${conversation},'user','context origin')`;
 await sql`INSERT INTO assistant.semantic_contexts(id,workspace_id,conversation_id,title,scope,source_sequence,initiating_message_id) SELECT ${context},workspace_id,conversation_id,'shared','shared topic',sequence,id FROM assistant.messages WHERE id=${source}`;
 const raw=await rawSource(sql,{workspace:f.workspace,conversation:f.conversation},f.answer),sha=await hashToken(JSON.stringify(raw));
 await sql`INSERT INTO assistant.semantic_context_sources(workspace_id,conversation_id,message_id,sha256,snapshot) VALUES(${f.workspace},${f.conversation},${f.answer},${sha},${JSON.stringify(raw)}::jsonb) ON CONFLICT DO NOTHING`;
 await sql`INSERT INTO assistant.semantic_context_links(workspace_id,conversation_id,message_id,context_id,revision,status,source_sequence,source_sha256,evidence) VALUES(${f.workspace},${f.conversation},${f.answer},${context},1,'confirmed',${raw.sequence},${sha},'[]')`;
 const result=await createClaims(sql,f.principal,f.run,await f.request(f.answer,[f.draft]));
 expect(result.created).toHaveLength(1);
 expect((await sql`SELECT context_id,conversation_id FROM assistant.semantic_claims WHERE id=${result.created[0]!}`)[0]).toEqual({context_id:context,conversation_id:f.conversation});
 const other=await fixture(),created=await createClaims(sql,other.principal,other.run,await other.request(other.answer,[other.draft]));
 await expect(sql`UPDATE assistant.semantic_claims SET context_id=${context} WHERE id=${created.created[0]!}`.execute()).rejects.toThrow();
});
