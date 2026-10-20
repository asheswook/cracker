import { expect, test } from 'bun:test';
import { Database } from 'bun:sqlite';
import { mkdtemp, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { Journal } from '../services/daemon/journal.ts';
import type { RunCheckpoint } from '../services/daemon/active-context.ts';
import type { ResponseInputItem } from '../packages/provider/index.ts';

for(const mode of ['safe','uncertain','corrupt_json','corrupt_schema','incomplete_boundary'] as const)test(`failure feedback preserves checkpoint safety for ${mode}`,async()=>{
 // Given a real durable journal with one completed action and its complete transcript boundary.
 const directory=await mkdtemp(join(tmpdir(),'journal-feedback-')),path=join(directory,'journal.sqlite');
 let journal=new Journal(path);
 const run=crypto.randomUUID();journal.start(run);journal.begin(run,'completed');journal.complete('completed','stored');
 const checkpoint:RunCheckpoint={version:1,assignment:{run_id:run,task:{id:crypto.randomUUID(),conversation_id:crypto.randomUUID(),objective:'fixture',state:'running',reason:null,created_at:new Date().toISOString(),updated_at:new Date().toISOString()},messages:[],instructions:'',memory:[]},input:[{type:'function_call',call_id:'completed',name:'shell',arguments:'{}'},{type:'function_call_output',call_id:'completed',output:'stored'}],cursor:4,seenCallIds:['completed'],artifacts:{directory,seen:[],inlineBytes:0},inputTokens:0};
 journal.checkpoint(checkpoint);
 if(mode==='uncertain')journal.begin(run,'uncertain');
 if(mode==='corrupt_json'||mode==='corrupt_schema'||mode==='incomplete_boundary'){
  const db=new Database(path);
  const payload=mode==='corrupt_json'?'{broken':mode==='corrupt_schema'?JSON.stringify({...checkpoint,version:999}):JSON.stringify({...checkpoint,input:checkpoint.input.slice(0,1)});
  try{db.query('UPDATE checkpoints SET payload=? WHERE run=?').run(payload,run);}finally{db.close();}
 }
 const feedback:ResponseInputItem={role:'user',content:JSON.stringify({kind:'runtime_failure_feedback',code:'fixture_failure'})};
 try{
  // When failure metadata is appended and the same journal is reopened.
  const appended=journal.appendFailureFeedback(run,feedback);
  journal.close();journal=new Journal(path);
  // Then only the already-safe transcript gains metadata; uncertainty never becomes replay-safe.
  expect(appended).toBe(mode==='safe');
  expect(journal.recoverySummary(run)).toEqual({completed_actions:1,uncertain_actions:mode==='uncertain'?1:0,history_available:mode==='safe'});
  if(mode==='safe')expect(journal.recoverable(run)).toEqual({...checkpoint,input:[...checkpoint.input,feedback]});
  else{expect(journal.recoverable(run)).toBeNull();expect(journal.resumeSafe(run)).toBe(false);}
 }finally{journal.close();await rm(directory,{recursive:true,force:true});}
});
