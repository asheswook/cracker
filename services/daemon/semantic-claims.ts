import type { Database } from 'bun:sqlite';
import { HTTPError, type KyInstance } from 'ky';
import { z } from 'zod';
import { Assignment, type DaemonEvent, type Message } from '../../packages/protocol';
import type { Provider } from '../../packages/provider';
import { ClaimBatch, CLAIM_PROMPT, CLAIM_VERSION } from '../../packages/context/claims-extraction';
import { Claim, ClaimsRequest } from '../../packages/context/claims-schema';
import { RawSource } from '../../packages/context/store-source';
import type { ProviderLease, RunModelResolver } from './model-resolver';

const Corpus=z.object({current:RawSource,source_sha256:z.string(),substantive:z.boolean(),ownership_pending:z.boolean().default(false),exchange_id:z.uuid().nullable(),claims:z.array(Claim),sources:z.array(RawSource),prior_sources:z.array(RawSource).default([]),recent_context:z.array(RawSource).default([]),exchanges:z.array(z.unknown())});
const Job=z.object({run:z.uuid(),message:z.uuid(),binding:Assignment.shape.model_binding,sequence:z.number().optional(),conversation_id:z.uuid().optional(),corpus:Corpus.optional(),prepared:ClaimsRequest.optional()});
const Entry=z.object({id:z.string(),payload:z.string(),attempts:z.number(),retry_at:z.number()});
const hash=(text:string)=>new Bun.CryptoHasher('sha256').update(text).digest('hex');
export class ClaimJobs {
 constructor(private readonly db:Database){db.exec('CREATE TABLE IF NOT EXISTS claim_jobs(id TEXT PRIMARY KEY,payload TEXT NOT NULL,attempts INTEGER NOT NULL DEFAULT 0,retry_at INTEGER NOT NULL DEFAULT 0); CREATE TABLE IF NOT EXISTS claim_receipts(id TEXT PRIMARY KEY); CREATE TABLE IF NOT EXISTS claim_runs(run TEXT PRIMARY KEY,binding TEXT NOT NULL); CREATE TABLE IF NOT EXISTS claim_quarantine(job TEXT PRIMARY KEY,count INTEGER NOT NULL); CREATE TABLE IF NOT EXISTS claim_provider_circuit(id INTEGER PRIMARY KEY,retry_at INTEGER NOT NULL);');}
 register(a:Assignment){if((a.semantic_structure_mode??'off')==='off'){this.db.transaction(()=>{this.db.query('DELETE FROM claim_runs WHERE run=?').run(a.run_id);this.db.query("DELETE FROM claim_jobs WHERE json_extract(payload,'$.run')=?").run(a.run_id);})();return;}this.db.query('INSERT OR REPLACE INTO claim_runs VALUES(?,?)').run(a.run_id,JSON.stringify(a.model_binding??null));}
 providerPaused(now=Date.now()){const row=z.object({retry_at:z.number()}).nullable().parse(this.db.query('SELECT retry_at FROM claim_provider_circuit WHERE id=1').get());return !!row&&row.retry_at>now;}
 enqueue(job:z.infer<typeof Job>){const id=`${job.message}:${CLAIM_VERSION}`;this.db.query('INSERT OR IGNORE INTO claim_jobs(id,payload) SELECT ?,? WHERE NOT EXISTS(SELECT 1 FROM claim_receipts WHERE id=?)').run(id,JSON.stringify(job),id);}
 user(a:Assignment,m:Message){if((a.semantic_structure_mode??'off')==='off'||m.synthetic||m.role!=='user')return;this.enqueue({run:a.run_id,message:m.id,binding:a.model_binding,sequence:m.sequence,conversation_id:m.conversation_id});}
 delivered(event:DaemonEvent){if(event.kind!=='message')return;const row=z.object({binding:z.string()}).nullable().parse(this.db.query('SELECT binding FROM claim_runs WHERE run=?').get(event.run_id));if(!row)return;this.enqueue({run:event.run_id,message:event.message_id??event.event_id,binding:Assignment.shape.model_binding.parse(JSON.parse(row.binding)??undefined)});}
 next(now=Date.now()){
  if(this.providerPaused(now))return null;
  // Server sequence, not arrival order. A newly observed predecessor can precede a
  // backed-off later job; a later correction can never skip a leased predecessor.
  return this.db.transaction(()=>{const entry=Entry.nullable().parse(this.db.query("SELECT id,payload,attempts,retry_at FROM claim_jobs ORDER BY json_extract(payload,'$.sequence'),rowid LIMIT 1").get());if(!entry||entry.retry_at>now)return null;this.db.query('UPDATE claim_jobs SET retry_at=? WHERE id=?').run(now+240000,entry.id);return entry;})();
 }
 unordered(){return z.array(Entry).parse(this.db.query("SELECT id,payload,attempts,retry_at FROM claim_jobs WHERE json_extract(payload,'$.sequence') IS NULL ORDER BY rowid LIMIT 256").all());}
 save(id:string,job:z.infer<typeof Job>){this.db.query('UPDATE claim_jobs SET payload=? WHERE id=?').run(JSON.stringify(job),id);}
 finish(id:string,quarantine=0){this.db.transaction(()=>{if(quarantine)this.db.query('INSERT OR REPLACE INTO claim_quarantine VALUES(?,?)').run(id,quarantine);this.db.query('INSERT OR IGNORE INTO claim_receipts VALUES(?)').run(id);this.db.query('DELETE FROM claim_jobs WHERE id=?').run(id);})();}
 retry(entry:z.infer<typeof Entry>,now:number,auth=false){if(auth)this.db.query('INSERT OR REPLACE INTO claim_provider_circuit VALUES(1,?)').run(now+300000);this.db.query('UPDATE claim_jobs SET attempts=attempts+1,retry_at=? WHERE id=?').run(now+(auth?300000:Math.min(300000,5000*2**Math.min(entry.attempts,6))),entry.id);}
}
export class SemanticClaims {
 private active:Promise<void>|undefined;
 private readonly abort=new AbortController();
 constructor(private readonly dependencies:{jobs:ClaimJobs;http:KyInstance;provider:Provider;models?:RunModelResolver}){}
 tick(){if(!this.active)this.active=this.process().catch(()=>console.warn(JSON.stringify({event:'daemon.claims.failure'}))).finally(()=>{this.active=undefined;});}
 async process(now=Date.now()){
  const {jobs,http}=this.dependencies;if(jobs.providerPaused(now))return;
  // Persist authoritative ordering before claiming the next lease. No provider calls here.
  for(const pending of jobs.unordered()){
   if(pending.retry_at>now)return;
   const job=Job.parse(JSON.parse(pending.payload));
   try{const metadata=z.object({sequence:z.number(),conversation_id:z.uuid()}).parse(await http.post(`v1/daemon/context/${job.run}/claims/read`,{json:{message_id:job.message,metadata_only:true},signal:AbortSignal.any([this.abort.signal,AbortSignal.timeout(10000)])}).json());jobs.save(pending.id,{...job,...metadata});}
   catch{jobs.retry(pending,now);return;}
  }
  if(jobs.unordered().length)return;
  const entry=jobs.next(now);if(!entry)return;let lease:ProviderLease|undefined;
  try{
   const job=Job.parse(JSON.parse(entry.payload)),path=`v1/daemon/context/${job.run}/claims`,signal=AbortSignal.any([this.abort.signal,AbortSignal.timeout(600000)]);
   if(!job.prepared){
    // Never send a saved corpus without re-reading current retention and source hashes.
    const corpus=Corpus.parse(await http.post(`${path}/read`,{json:{message_id:job.message,prepare:true},signal}).json());
    // Attribution may still be in the structure queue; do not permanently lose an answer.
    if(corpus.ownership_pending)throw new Error('claim_attribution_pending');
    job.corpus=corpus;jobs.save(entry.id,job);
    let claims:unknown[]=[],updates:unknown[]=[],quarantineReason:'claim_invalid_envelope'|'claim_missing_exchange'|undefined=corpus.current.role==='assistant'&&!corpus.exchange_id?'claim_missing_exchange':undefined;
    if(corpus.substantive||corpus.claims.some(c=>!['corrected','retracted'].includes(c.current_status))){
     lease=await this.dependencies.models?.forRun(job.run,signal,job.binding);
     const response=await (lease?.provider??this.dependencies.provider).respond([{role:'system',content:CLAIM_PROMPT},{role:'user',content:JSON.stringify(corpus)}],[{type:'function',name:'record_w2_claims',description:'Return claim metadata only.',strict:true,parameters:z.toJSONSchema(ClaimBatch)}],signal);
     const calls=response.output.filter(c=>c.type==='function_call');
     try{
      if(calls.length!==1||calls[0]?.name!=='record_w2_claims')throw new Error('claim_invalid_envelope');
      // W1 owns anchors. Invalid unused anchor metadata cannot discard valid claims.
      const envelope=z.object({claims:z.array(z.unknown()).max(128),updates:z.array(z.unknown()).max(128)}).parse(JSON.parse(calls[0].arguments));
      claims=envelope.claims.map((item,ordinal)=>item&&typeof item==='object'?{...item,ordinal}:item);
      updates=envelope.updates.map(item=>{if(!item||typeof item!=='object')return item;const id='claim_id'in item?item.claim_id:null;return {...item,expected_revision:corpus.claims.find(c=>c.id===id)?.revision};});
     }catch{quarantineReason='claim_invalid_envelope';}
     job.prepared=ClaimsRequest.parse({message_id:job.message,source_sha256:corpus.source_sha256,extractor_version:CLAIM_VERSION,provider_model:response.model,prompt_sha256:hash(CLAIM_PROMPT),schema_version:'1',request_sha256:hash(JSON.stringify(corpus)),claims,updates,quarantine_reason:quarantineReason});
    }else job.prepared=ClaimsRequest.parse({message_id:job.message,source_sha256:corpus.source_sha256,extractor_version:CLAIM_VERSION,provider_model:'no-inference',prompt_sha256:hash(CLAIM_PROMPT),schema_version:'1',request_sha256:hash(JSON.stringify(corpus)),claims,updates,quarantine_reason:quarantineReason});
    // Exact mutation persisted before transport, including invalid siblings for server quarantine.
    jobs.save(entry.id,job);
   }
   const result=z.object({quarantine:z.array(z.unknown())}).parse(await http.post(path,{json:job.prepared,signal}).json());
   jobs.finish(entry.id,result.quarantine.length);
   if(result.quarantine.length)console.info(JSON.stringify({event:'daemon.claims.quarantine',count:result.quarantine.length}));
  }catch(error){
   if(error instanceof HTTPError&&error.response.status===409){
    const body=z.object({error:z.object({code:z.string()})}).safeParse(await error.response.clone().json().catch(()=>null));
    if(body.success&&['stale_revision','stale_source','claim_predecessor_pending'].includes(body.data.error.code)){
     const job=Job.parse(JSON.parse(entry.payload));delete job.corpus;delete job.prepared;jobs.save(entry.id,job);
    }
    if(body.success&&['retention_denied','claim_synthetic_source','invalid_source','claim_invalid_source','claim_out_of_order'].includes(body.data.error.code)){jobs.finish(entry.id,1);console.info(JSON.stringify({event:'daemon.claims.quarantine',count:1}));return;}
   }
   const auth=error instanceof Error&&/auth|invalid_grant|login|refresh|401|403/i.test(error.message);
   // The FIFO head is a durable provider circuit: restart cannot bypass auth backoff.
   jobs.retry(entry,now,auth);console.warn(JSON.stringify({event:auth?'daemon.claims.auth_paused':'daemon.claims.retry',attempt:entry.attempts+1}));
  }finally{await lease?.release();}
 }
 async stop(){this.abort.abort();await this.active;}
}
