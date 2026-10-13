import {expect,test} from 'bun:test';
import type {Provider,ResponseInputItem} from '../packages/provider';
import {DaemonEvent,type Assignment,type Command} from '../packages/protocol';
import {Journal} from '../services/daemon/journal';
import {Runtime} from '../services/daemon/runtime';
import {ToolExecutor} from '../services/daemon/tools';

function response(requestControl:boolean):Awaited<ReturnType<Provider['respond']>> {
 return {id:'fixture',created_at:0,output_text:requestControl?'':'done',error:null,incomplete_details:null,instructions:null,metadata:null,model:'fixture',object:'response',
 output:requestControl?[{type:'function_call',id:'request',call_id:'control-call',name:'request_computer_control',arguments:JSON.stringify({reason:'Need to enter the requested setting in the shared browser.'})}]:[{id:'reply',type:'message',role:'assistant',status:'completed',content:[{type:'output_text',text:'done',annotations:[]}]}],parallel_tool_calls:false,temperature:null,tool_choice:'auto',tools:[],top_p:null,status:'completed'};
}
for(const allowed of [true,false])test(`explicit model computer request settles without restarting inference; allowed=${allowed}`,async()=>{
 const requestReceived=Promise.withResolvers<void>(),finished=Promise.withResolvers<void>();
 const events:DaemonEvent[]=[],outputs:ResponseInputItem[]=[];
 const assignment:Assignment={run_id:crypto.randomUUID(),task:{id:crypto.randomUUID(),conversation_id:crypto.randomUUID(),objective:'fixture',state:'running',reason:null,created_at:new Date().toISOString(),updated_at:new Date().toISOString()},messages:[],instructions:'',memory:[]};
 let assigned=false,calls=0,offered=false,command:Command|undefined,requestCount=0;
 const server=Bun.serve({port:0,async fetch(request){
  const url=new URL(request.url);
  if(url.pathname==='/v1/daemon/poll'){const value=assigned?null:assignment;assigned=true;return Response.json({assignment:value,commands:command?[command]:[],messages:[]});}
  if(url.pathname==='/v1/daemon/computer-control'){
   requestCount++;requestReceived.resolve();
   if(!allowed)return Response.json({error:{code:'command_pending',message:'User takeover is pending'}},{status:409});
   command={id:crypto.randomUUID(),task_id:assignment.task.id,kind:'return_control',created_at:new Date().toISOString()};
   return Response.json({control_state:'switching',command});
  }
  if(url.pathname==='/v1/daemon/events'){
   const event=DaemonEvent.parse(await request.json());events.push(event);
   if(event.kind==='command_ack')command=undefined;
   if(event.kind==='state'&&event.state==='succeeded')finished.resolve();
   return Response.json({accepted:true});
  }
  return Response.json({messages:[],memory:[],instructions:''});
 }});
 const journal=new Journal(':memory:');journal.setControl('user');
 const provider:Provider={respond:async(input,tools)=>{offered=tools.some(tool=>tool.type==='function'&&tool.name==='request_computer_control');calls++;if(calls>1)outputs.push(...input);return response(calls===1);}};
 const runtime=new Runtime({controlUrl:server.url.href,token:'fixture',journal,tools:new ToolExecutor(),provider});
 try{
  await runtime.tick();await requestReceived.promise;
  if(allowed)await runtime.tick();
  await finished.promise;
  const output=outputs.find(item=>'type' in item&&item.type==='function_call_output');
  expect(output&&'output' in output&&typeof output.output==='string'?JSON.parse(output.output).status:null).toBe(allowed?'granted':'unavailable');
  expect(offered).toBe(true);expect(calls).toBe(2);expect(requestCount).toBe(1);
  expect(events.filter(event=>event.kind==='state').map(event=>event.state)).toEqual(['succeeded']);
  expect(events.filter(event=>event.kind==='message').map(event=>event.run_id)).toEqual([assignment.run_id]);
  expect(journal.control()).toBe(allowed?'agent':'user');
  expect(events.some(event=>event.kind==='command_ack'&&event.execution_continues===true)).toBe(allowed);
 }finally{await runtime.stop();journal.close();await server.stop(true);}
});
