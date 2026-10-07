import ky,{HTTPError} from "ky";
import {z} from "zod";
import {Skill,Server} from "../packages/extensions/schema.ts";
import {Message,Task} from "../packages/protocol/index.ts";
class ExtensionProbeError extends Error{constructor(readonly code:string){super(code);this.name="ExtensionProbeError";}}
async function probe():Promise<void>{
 const connection=z.object({control_url:z.url(),client_token:z.string(),vm_id:z.uuid()}).parse(await Bun.file('.local/remote-connection.json').json());
 const http=ky.create({prefixUrl:connection.control_url,headers:{Authorization:`Bearer ${connection.client_token}`},timeout:15000,retry:0});
 const tasks=async()=>z.object({tasks:z.array(Task)}).parse(await http.get('v1/tasks').json()).tasks;
 if((await tasks()).some(task=>!['succeeded','failed','cancelled'].includes(task.state)))throw new ExtensionProbeError('unrelated_active_work');
 const marker=`EXTENSION_PROOF_${crypto.randomUUID()}`,secret=`SYNTHETIC_SECRET_${crypto.randomUUID()}`,name=`QA skill ${crypto.randomUUID().slice(0,8)}`;
 let skillId:string|undefined,serverId:string|undefined;
 const started=Date.now();
 try{
  const server=z.object({server:Server}).parse(await http.post('v1/extensions/servers',{json:{vm_id:connection.vm_id,name:'QA actual stdio fixture',enabled:true,config:{transport:'stdio',command:'/home/ubuntu/.bun/bin/bun',args:['/home/ubuntu/.local/share/autonomous-assistant/tests/mcp-extension-fixture.ts']},secrets:{FIXTURE_SECRET:secret}}}).json()).server;serverId=server.id;
  const skill=z.object({skill:Skill}).parse(await http.post('v1/extensions/skills',{json:{vm_id:connection.vm_id,name,description:'QA skill for the explicitly requested extension acceptance test.',enabled:true,content:`# Extension acceptance\nCall the configured MCP fixture_echo tool with value exactly ${marker}. Read its actual returned proof and pid. Reply only with JSON containing those two fields. Do not call shell, do not invent the proof, and do not reveal fixture_secret. This task requires the MCP tool result.`}}).json()).skill;skillId=skill.id;
  const settings=async()=>z.object({skills:z.array(Skill),servers:z.array(Server)}).parse(await http.get('v1/extensions',{searchParams:{vm_id:connection.vm_id}}).json());
  let connected=false;
  while(Date.now()-started<90000){const current=await settings(),observed=current.servers.find(s=>s.id===server.id),ready=current.skills.find(s=>s.id===skill.id);if(observed?.state==='error')throw new ExtensionProbeError(`mcp_${observed.error_code}`);if(observed?.state==='connected'&&observed.observed_revision===observed.revision&&observed.tool_count===1&&ready?.state==='ready'){connected=true;break;}await Bun.sleep(1500);}
  if(!connected)throw new ExtensionProbeError('configuration_apply_deadline');
  const conversation=z.object({conversation:z.object({id:z.uuid()})}).parse(await http.post('v1/conversations',{json:{title:'Live skills and MCP acceptance'}}).json()).conversation.id;
  const task=z.object({task:Task}).parse(await http.post(`v1/conversations/${conversation}/messages`,{json:{client_message_id:crypto.randomUUID(),content:`Load the enabled skill named "${name}" and perform its instructions using the configured MCP tool. Use the skill body, not assumptions. Do not run shell or create any follow-up work.`}}).json()).task;
  let succeeded=false;
  while(Date.now()-started<180000){const current=(await tasks()).find(t=>t.id===task.id);if(current&&['unknown','failed','cancelled'].includes(current.state))throw new ExtensionProbeError(`task_${current.state}`);if(current?.state==='succeeded'){succeeded=true;break;}await Bun.sleep(1500);}
  const messages=z.object({messages:z.array(Message)}).parse(await http.get(`v1/conversations/${conversation}/messages`).json()).messages;
  const reply=messages.filter(m=>m.role==='assistant').at(-1)?.content??'';
  if(!succeeded||!reply.includes(`${marker}::`)||reply.includes(secret))throw new ExtensionProbeError('actual_skill_tool_result_missing');
  const match=reply.match(/EXTENSION_PROOF_[a-f0-9-]+::[a-f0-9-]+/);
  if(!match?.[0])throw new ExtensionProbeError('proof_format_missing');
  await http.post('v1/extensions/servers',{json:{id:server.id,vm_id:connection.vm_id,name:server.name,enabled:false,config:server.config}});
  await http.post('v1/extensions/skills',{json:{id:skill.id,vm_id:connection.vm_id,name:skill.name,description:skill.description,content:skill.content,enabled:false}});
  let disabled=false;const stopDeadline=Date.now()+45000;
  while(Date.now()<stopDeadline){const current=await settings();if(current.servers.find(s=>s.id===server.id)?.state==='disabled'&&current.skills.find(s=>s.id===skill.id)?.state==='disabled'){disabled=true;break;}await Bun.sleep(1500);}
  if(!disabled)throw new ExtensionProbeError('disable_apply_deadline');
  console.log(JSON.stringify({verified_at:new Date().toISOString(),surface:'deployed PG configuration + installed Linux daemon + actual OAuth model + actual stdio MCP',conversation_id:conversation,task_id:task.id,skill_id:skill.id,server_id:server.id,proof:match[0],source_marker_only_in_skill_body:true,observed_connected_tools:1,secret_absent_from_reply:true,disabled_observed:true,elapsed_ms:Date.now()-started,requires_journal_result_crosscheck:true}));
 }finally{if(skillId)await http.delete(`v1/extensions/skills/${skillId}`);if(serverId)await http.delete(`v1/extensions/servers/${serverId}`);}
}
try{await probe();}catch(error){console.error(JSON.stringify({failed:true,type:error instanceof Error?error.name:'unknown',code:error instanceof ExtensionProbeError?error.code:error instanceof HTTPError?`http_${error.response.status}`:'probe_failed'}));process.exitCode=1;}
