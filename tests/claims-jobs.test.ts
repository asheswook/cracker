import { expect, test } from 'bun:test';
import { Database } from 'bun:sqlite';
import ky from 'ky';
import type { Response as ModelResponse } from 'openai/resources/responses/responses';
import { Assignment } from '../packages/protocol';
import { ClaimJobs, SemanticClaims } from '../services/daemon/semantic-claims';

const uuid=()=>crypto.randomUUID(),date='2026-01-01T00:00:00.000Z';
function fixture(){
 const run=uuid(),message=uuid(),task=uuid(),conversation=uuid();
 const assignment=Assignment.parse({run_id:run,task:{id:task,conversation_id:conversation,objective:'claims',state:'running',reason:null,created_at:date,updated_at:date},messages:[{id:message,task_id:task,conversation_id:conversation,role:'user',content:'원문',sequence:1,created_at:date,client_message_id:null}],instructions:'',memory:[],semantic_structure_mode:'shadow'});
 const corpus={current:{message_id:message,task_id:task,sequence:1,role:'assistant',content:'원문',created_at:date,attachments:[]},source_sha256:'a'.repeat(64),substantive:true,exchange_id:uuid(),claims:[],sources:[],exchanges:[]};
 return {run,message,assignment,corpus};
}
function response(value:unknown):ModelResponse{return {id:uuid(),created_at:0,output_text:'',error:null,incomplete_details:null,instructions:null,metadata:null,model:'mock',object:'response',output:[{type:'function_call',call_id:uuid(),name:'record_w2_claims',arguments:JSON.stringify(value)}],parallel_tool_calls:false,temperature:null,tool_choice:'auto',tools:[],top_p:null,status:'completed'};}
const empty={anchor_exchange_id:null,relation:'new_topic',anchor_quote:null,anchor_confidence:0,claims:[],updates:[]};
test('claim job retries exact persisted request after restart; leased head cannot be overtaken',async()=>{
 const f=fixture(),db=new Database(':memory:'),jobs=new ClaimJobs(db),writes:string[]=[];let calls=0,fail=true;
 jobs.enqueue({run:f.run,message:f.message,sequence:1});jobs.enqueue({run:f.run,message:uuid(),sequence:2});
 const http=ky.create({prefixUrl:'http://fixture/',retry:0,fetch:async(input)=>{const request=input instanceof Request?input:new Request(input);if(request.url.endsWith('/read'))return Response.json(f.corpus);writes.push(await request.text());if(fail){fail=false;return Response.json({},{status:503});}return Response.json({quarantine:[]});}});
 const worker=new SemanticClaims({jobs,http,provider:{respond:async()=>{calls++;return response(empty);}}}),now=Date.now();
 await worker.process(now);expect(calls).toBe(1);expect(writes).toHaveLength(1);expect(jobs.next(now+4999)).toBeNull();
 const restart=new SemanticClaims({jobs:new ClaimJobs(db),http,provider:{respond:async()=>{throw new Error('must not re-infer');}}});await restart.process(now+5000);
 expect(writes).toHaveLength(2);expect(writes[0]).toBe(writes[1]);jobs.enqueue({run:f.run,message:f.message});
 expect(db.query('SELECT count(*) AS n FROM claim_jobs').get()).toEqual({n:1});db.close();
});
test('claim authentication circuit survives worker restart and retries later without overtaking',async()=>{
 const f=fixture(),db=new Database(':memory:'),jobs=new ClaimJobs(db);let calls=0;
 jobs.enqueue({run:f.run,message:f.message,sequence:1});jobs.enqueue({run:f.run,message:uuid(),sequence:2});
 const dependencies={jobs,http:ky.create({prefixUrl:'http://fixture/',fetch:async()=>Response.json(f.corpus)}),provider:{respond:async()=>{calls++;throw new Error('invalid_grant PRIVATE');}}};
 const now=Date.now();await new SemanticClaims(dependencies).process(now);await new SemanticClaims({...dependencies,jobs:new ClaimJobs(db)}).process(now+299999);expect(calls).toBe(1);await new SemanticClaims(dependencies).process(now+300000);expect(calls).toBe(2);db.close();
});
test('flag off makes no HTTP/provider calls; malformed envelope is durably quarantined',async()=>{
 const f=fixture(),db=new Database(':memory:'),jobs=new ClaimJobs(db);let calls=0;
 const off={...f.assignment,semantic_structure_mode:'off' as const};jobs.register(off);jobs.user(off,off.messages[0]!);
 const http=ky.create({prefixUrl:'http://fixture/',fetch:async input=>{calls++;return Response.json(String(input instanceof Request?input.url:input).endsWith('/read')?f.corpus:{quarantine:[{reason:'claim_invalid_envelope'}]});}}),worker=new SemanticClaims({jobs,http,provider:{respond:async()=>{calls++;return response({claims:'wrong'});}}});
 await worker.process();expect(calls).toBe(0);jobs.enqueue({run:f.run,message:f.message,sequence:1});await worker.process();expect(calls).toBe(3);expect(jobs.next()).toBeNull();expect(db.query('SELECT count FROM claim_quarantine').get()).toEqual({count:1});db.close();
});
test('provider retry revalidates retention before sending cached private source again',async()=>{
 const f=fixture(),db=new Database(':memory:'),jobs=new ClaimJobs(db);let denied=false,providers=0,reads=0;
 jobs.enqueue({run:f.run,message:f.message,sequence:1});
 const http=ky.create({prefixUrl:'http://fixture/',retry:0,fetch:async()=>{reads++;return denied?Response.json({error:{code:'retention_denied'}},{status:409}):Response.json(f.corpus);}});
 const worker=new SemanticClaims({jobs,http,provider:{respond:async()=>{providers++;throw new Error('transport failure');}}}),now=Date.now();
 await worker.process(now);denied=true;await worker.process(now+5000);expect(reads).toBe(2);expect(providers).toBe(1);expect(jobs.next(now+10000)).toBeNull();db.close();
});
test('authoritative source sequence orders delayed events before later queue entries',async()=>{
 const f=fixture(),db=new Database(':memory:'),jobs=new ClaimJobs(db),early=uuid(),writes:string[]=[];
 jobs.enqueue({run:f.run,message:f.message});jobs.enqueue({run:f.run,message:early});
 const http=ky.create({prefixUrl:'http://fixture/',retry:0,fetch:async input=>{
  const request=input instanceof Request?input:new Request(input),body=await request.json() as {message_id?:string;metadata_only?:boolean};
  if(body.metadata_only)return Response.json({sequence:body.message_id===early?1:2,conversation_id:f.assignment.task.conversation_id});
  if(request.url.endsWith('/read'))return Response.json({...f.corpus,current:{...f.corpus.current,message_id:body.message_id}});
  writes.push(body.message_id!);return Response.json({quarantine:[]});
 }});
 const worker=new SemanticClaims({jobs,http,provider:{respond:async()=>response(empty)}});await worker.process();expect(writes).toEqual([early]);db.close();
});
