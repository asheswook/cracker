import OpenAI from 'openai';
import {z} from 'zod';
import {consumeResponse,type Tool} from '../packages/provider/index.ts';
import {planResponse} from '../packages/provider/response-plan.ts';
import {providerFailure} from '../packages/provider/diagnostic.ts';
const models=['gpt-6-astra','gpt-6.1-sol','gpt-6-luna'] as const;
const Observation=z.object({application:z.string(),folder_path:z.string(),files:z.array(z.object({name:z.string(),bytes:z.number().int()})),terminal_marker:z.string(),target_filename:z.string(),proposed_action:z.object({kind:z.enum(['click','double_click','none']),x:z.number(),y:z.number()}),executed:z.boolean()});
const schema=z.toJSONSchema(Observation);delete schema['$schema'];
const tool:Tool={type:'function',name:'report_observation',description:'Report observations and a proposed next click; this function never performs any action.',strict:true,parameters:schema};
const file1='DESKTOP_8c267f629cdc438bb601228e2db4f262.txt',file2='DESKTOP_bbacd0a7616f4f6fadc524624081a107.txt';
async function main(){
 const image=await Bun.file('.omo/evidence/desktop/batch-astra.png').arrayBuffer();
 const hash=new Bun.CryptoHasher('sha256').update(image).digest('hex');
 const client=new OpenAI({apiKey:z.string().min(1).parse(process.env['OPENAI_API_KEY']),maxRetries:0,timeout:60000});
 for(const model of models){
  const started=performance.now();let firstEvent:number|null=null,firstArguments:number|null=null;
  try{
   const stream=await client.responses.create({model,service_tier:'default',reasoning:{effort:'low'},store:false,stream:true,parallel_tool_calls:false,max_output_tokens:1024,tools:[tool],tool_choice:{type:'function',name:'report_observation'},include:['reasoning.encrypted_content'],input:[{role:'user',content:[{type:'input_text',text:'Analyze this static screenshot. Do not interact with any computer. Call report_observation exactly once: identify the foreground application and displayed folder path; transcribe every visible file name and its byte size in that foreground window; transcribe the DESKTOP_ marker printed as output in the upper-left terminal (without the Korean prefix); identify which listed file matches that marker. Propose the next mouse action and an interior screen-pixel point on its filename to OPEN that matching file. Report executed:false, because this is only an observation and proposal. Do not infer unseen files. Coordinates refer to the original screenshot.'},{type:'input_image',image_url:`data:image/png;base64,${Buffer.from(image).toString('base64')}`,detail:'original'}]}]},{signal:AbortSignal.timeout(60000)});
   async function* measured(){for await(const event of stream){if(firstEvent===null)firstEvent=Math.round(performance.now()-started);if(event.type==='response.function_call_arguments.delta'&&firstArguments===null)firstArguments=Math.round(performance.now()-started);yield event;}}
   const response=await consumeResponse(measured()),plan=planResponse(response,[tool]);
   const calls=response.output.filter(item=>item.type==='function_call');const call=calls[0];
   const observation=call?Observation.parse(JSON.parse(call.arguments)):null;
   const checks={single_valid_call:plan.kind==='calls'&&calls.length===1,application:observation?.application.toLowerCase().includes('thunar')??false,path:observation?.folder_path.replace(/\/$/,'')==='/home/ubuntu/Documents/Assistant-QA',files:observation?.files.length===2&&[file1,file2].every(name=>observation.files.some(file=>file.name===name&&file.bytes===48)),marker:observation?.terminal_marker===file2.replace('.txt',''),target:observation?.target_filename===file2,click:observation?.proposed_action.kind==='double_click'&&observation.proposed_action.x>=815&&observation.proposed_action.x<=1180&&observation.proposed_action.y>=424&&observation.proposed_action.y<=447,no_effect:observation?.executed===false};
   console.log(JSON.stringify({at:new Date().toISOString(),mode:'api',transport:'http_sse',fixture_sha256:hash,requested_model:model,returned_model:response.model,requested_tier:'default',returned_tier:response.service_tier??null,reasoning_effort:'low',first_event_ms:firstEvent,first_arguments_ms:firstArguments,completed_ms:Math.round(performance.now()-started),checks,all_pass:Object.values(checks).every(Boolean),observation,usage:response.usage?{input_tokens:response.usage.input_tokens,output_tokens:response.usage.output_tokens,total_tokens:response.usage.total_tokens,cached_tokens:response.usage.input_tokens_details.cached_tokens,reasoning_tokens:response.usage.output_tokens_details.reasoning_tokens}:null}));
  }catch(error){console.log(JSON.stringify({requested_model:model,requested_tier:'default',failed:true,...providerFailure(error),http_status:error instanceof OpenAI.APIError?error.status??null:null}));}
 }
}
try{await main();}catch(error){console.error(JSON.stringify({failed:true,stage:'fixture_or_configuration',type:error instanceof z.ZodError?'invalid_config':'unavailable'}));process.exitCode=1;}
