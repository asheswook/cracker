import OpenAI from 'openai';
import {ResponsesWS} from 'openai/resources/responses/ws';
import {z} from 'zod';
import {readCredential} from '../packages/provider/credentials.ts';
import {consumeResponse,type ResponseInputItem} from '../packages/provider/index.ts';
import {socketDiagnostic,providerFailure} from '../packages/provider/diagnostic.ts';
import {ProviderError} from '../packages/provider/errors.ts';
import type {ResponseStreamEvent} from 'openai/resources/responses/responses';
class ProbeError extends Error{constructor(readonly code:string){super(code);}}
let phase='configuration';
async function main(){
 if(process.platform!=='linux')throw new ProbeError('oauth_probe_requires_linux_vm');
 const path=z.string().min(1).parse(process.env['CHATGPT_TOKEN_FILE']);
 phase='credential';const credential=await readCredential(path);
 const ws=new ResponsesWS(new OpenAI({apiKey:credential.access_token,maxRetries:0,timeout:30000}),{reconnect:null});
 const events=ws.stream(),deadline=Promise.withResolvers<never>();
 const timer=setTimeout(()=>{ws.close();ws.socket.platformSocket.terminate();deadline.reject(new ProbeError('deadline'));},30000);
 const start=performance.now();let firstText:number|null=null,identity:string|undefined;
 phase='connect_and_response';
 async function* responses():AsyncGenerator<ResponseStreamEvent>{
  for await(const event of events){
   if(event.type==='error')throw new ProviderError('incomplete','WebSocket transport failed',socketDiagnostic(event.error));
   if(event.type==='close')throw new ProviderError('incomplete','WebSocket closed before completion');
   if(event.type==='raw')throw new ProviderError('incomplete','WebSocket returned an unsupported raw frame');
   if(event.type!=='message')continue;
   const message=event.message;
   if(message.type==='response.created')identity=z.object({response:z.object({id:z.string()})}).parse(message).response.id;
   if(message.type==='response.output_text.delta'&&firstText===null)firstText=Math.round(performance.now()-start);
   if(message.type==='response.completed'&&(!identity||message.response.id!==identity))throw new ProbeError('terminal_identity_mismatch');
   yield message;
  }
 }
 try{
  const input:ResponseInputItem[]=[{role:'user',content:'Reply exactly STANDARD-UNNAMED-731 and nothing else.'}];
  ws.send({type:'response.create',model:'gpt-6-astra',reasoning:{effort:'low'},service_tier:'default',store:false,parallel_tool_calls:false,include:['reasoning.encrypted_content'],tools:[],input});
  const response=await Promise.race([consumeResponse(responses()),deadline.promise]);
  console.log(JSON.stringify({verified_at:new Date().toISOString(),mode:'chatgpt',transport:'websocket',lane:'implicit_default',requested_model:'gpt-6-astra',returned_model:response.model,requested_tier:'default',returned_tier:response.service_tier??null,reasoning_effort:'low',stream_id_used:false,previous_response_id_used:false,max_output_tokens_used:false,status:response.status,correct:response.output_text.trim()==='STANDARD-UNNAMED-731',first_text_ms:firstText,response_ms:Math.round(performance.now()-start),usage:response.usage?{input_tokens:response.usage.input_tokens,output_tokens:response.usage.output_tokens,total_tokens:response.usage.total_tokens}:null}));
  if(response.output_text.trim()!=='STANDARD-UNNAMED-731')throw new ProbeError('incorrect_marker');
  if(response.service_tier!=='default')throw new ProbeError('unverified_standard_tier');
 }finally{clearTimeout(timer);ws.close();ws.socket.platformSocket.terminate();await events.return?.();}
}
try{await main();}catch(error){console.error(JSON.stringify({event:'unnamed_oauth_probe_failed',phase,...providerFailure(error),code:error instanceof ProbeError?error.code:error instanceof z.ZodError?'invalid_config_or_response':'transport_or_provider_failed'}));process.exitCode=1;}
