import ky,{HTTPError} from 'ky';
import {z} from 'zod';
const Connection=z.object({control_url:z.url(),client_token:z.string(),vm_id:z.uuid()});
const Receipt=z.object({command:z.object({id:z.uuid(),kind:z.string(),status:z.string(),created_at:z.string(),acked_at:z.string().nullable()})});
class ProbeError extends Error{constructor(readonly code:string){super(code);}}
async function main(){
 const connection=Connection.parse(await Bun.file('.local/remote-connection.json').json());
 const http=ky.create({prefixUrl:connection.control_url,headers:{authorization:`Bearer ${connection.client_token}`},retry:0,timeout:15000});
 const tasks=z.object({tasks:z.array(z.object({state:z.string()}))}).parse(await http.get('v1/tasks').json());
 if(tasks.tasks.some(task=>['queued','running','waiting','cancelling'].includes(task.state)))throw new ProbeError('workspace_not_idle');
 const vms=z.object({vms:z.array(z.object({id:z.uuid(),control_state:z.string()}))}).parse(await http.get('v1/vms').json());
 if(vms.vms.find(vm=>vm.id===connection.vm_id)?.control_state!=='agent')throw new ProbeError('agent_control_required');
 const perform=async(kind:'takeover'|'return_control')=>{
  const id=crypto.randomUUID(),start=performance.now(),startedAt=new Date().toISOString();
  const submitted=await http.post(`v1/vms/${connection.vm_id}/control`,{json:{kind,client_command_id:id}});
  const submittedMs=Math.round(performance.now()-start);
  for(let attempt=0;attempt<60;attempt++){
   const observed=await http.get(`v1/commands/${id}`);
   const receipt=Receipt.parse(await observed.json()).command;
   if(receipt.status!=='pending'){
    console.log(JSON.stringify({kind,command_id:id,started_at:startedAt,post_cf_ray:submitted.headers.get("cf-ray")?.slice(0,128)??null,post_cf_placement:submitted.headers.get("cf-placement")?.slice(0,128)??null,receipt_cf_ray:observed.headers.get("cf-ray")?.slice(0,128)??null,receipt_cf_placement:observed.headers.get("cf-placement")?.slice(0,128)??null,post_ms:submittedMs,observed_ms:Math.round(performance.now()-start),status:receipt.status,created_at:receipt.created_at,acked_at:receipt.acked_at,server_ack_ms:receipt.acked_at?Date.parse(receipt.acked_at)-Date.parse(receipt.created_at):null}));
    if(receipt.status!=='applied')throw new ProbeError('command_not_applied');return;
   }
   await Bun.sleep(300);
  }
  throw new ProbeError('receipt_deadline');
 };
 await perform('takeover');await perform('return_control');
}
try{await main();}catch(error){console.error(JSON.stringify({event:'control_probe_failed',code:error instanceof ProbeError?error.code:error instanceof HTTPError?'http_error':'unexpected',status:error instanceof HTTPError?error.response.status:null}));process.exitCode=1;}
