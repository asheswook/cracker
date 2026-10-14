import { expect, test } from 'bun:test';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { Response } from 'openai/resources/responses/responses';
import { Runtime } from '../services/daemon/runtime';
import { Journal } from '../services/daemon/journal';
import { ToolExecutor } from '../services/daemon/tools';
import { backgroundRetry } from '../packages/provider/retry';
import { controlFixture } from './control-fixture';
import { createBackgroundTask } from '../services/control/repository/common';
import { Message } from '../packages/protocol';
import { z } from 'zod';

const f=controlFixture();
class TestJournal extends Journal {
  readonly finished=Promise.withResolvers<void>();
  override finish(run:string){super.finish(run);this.finished.resolve();}
}
class NoDesktopTools extends ToolExecutor {
  override async resetDesktop(){return;}
}
for(const report of ['Completed autonomously','NO_REPORT'])test(`background runtime suppresses composing, applies retry budget, normalizes final phase: ${report}`,async()=>{
  await f.finishActive();
  const conversation=await f.newConversation();
  await f.sql.begin(tx=>createBackgroundTask(tx,{workspace:f.workspace,conversation:conversation.id,objective:'Background fixture',origin:'schedule',clientId:crypto.randomUUID()}));
  const directory=await mkdtemp(join(tmpdir(),'background-runtime-'));
  const journal=new TestJournal(':memory:');
  let calls=0,composing=0;
  const server=Bun.serve({port:0,fetch:request=>{
    if(new URL(request.url).pathname==='/v1/daemon/composing')composing++;
    return f.app.fetch(request);
  }});
  const runtime=new Runtime({controlUrl:server.url.href,token:f.machine,journal,tools:new NoDesktopTools(),artifactRoot:directory,provider:{respond:async(input,_tools,_signal,observer,budget)=>{
    expect(observer).toBeUndefined();expect(budget).toBe(backgroundRetry);
    expect(input.some(item=>'content' in item&&typeof item.content==='string'&&item.content.includes('Do not ask the user questions; finish autonomously.'))).toBe(true);
    calls++;
    return {id:crypto.randomUUID(),created_at:0,output_text:'',error:null,incomplete_details:null,instructions:null,metadata:null,model:'fixture',object:'response',output:[{type:'message',id:crypto.randomUUID(),role:'assistant',status:'completed',...(calls===1?{phase:'commentary' as const}:{}),content:[{type:'output_text',text:calls===1?'Private progress':report,annotations:[]}]}],parallel_tool_calls:false,temperature:null,tool_choice:'auto',tools:[],top_p:null,status:'completed'} satisfies Response;
  }}});
  try{
    await runtime.tick();await journal.finished.promise;await runtime.flush();
    expect(calls).toBe(2);expect(composing).toBe(0);
    const messages=z.array(Message).parse(await f.sql`SELECT * FROM assistant.messages WHERE conversation_id=${conversation.id} AND role='assistant' ORDER BY sequence`);
    expect(messages.map(message=>message.hidden)).toEqual([true,report==='NO_REPORT']);
    expect(messages[1]?.phase).toBe('final_answer');
    expect((await f.sql`SELECT state FROM assistant.tasks WHERE conversation_id=${conversation.id}`)[0]?.['state']).toBe('succeeded');
  }finally{await runtime.stop();journal.close();await server.stop(true);await rm(directory,{recursive:true,force:true});}
},30000);
