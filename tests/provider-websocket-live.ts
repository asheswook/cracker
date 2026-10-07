import OpenAI from 'openai';
import {z} from 'zod';
import {readCredential} from '../packages/provider/credentials.ts';
import {providerFailure} from '../packages/provider/diagnostic.ts';
import {ResponseSocketPool} from '../packages/provider/websocket.ts';
const Config=z.object({PROBE_MODE:z.enum(['api','chatgpt']),PROBE_TURNS:z.coerce.number().int().min(1).max(2).default(2),OPENAI_API_KEY:z.string().optional(),CHATGPT_TOKEN_FILE:z.string().optional()});
class ProbeError extends Error{constructor(readonly code:string){super(code);}}
let phase="configuration";
async function main(){
 const config=Config.parse(process.env);
 if(config.PROBE_MODE==='chatgpt'&&process.platform!=='linux')throw new ProbeError('oauth_probe_requires_linux_vm');
 phase="credential";
 const token=config.PROBE_MODE==='chatgpt'?(await readCredential(z.string().min(1).parse(config.CHATGPT_TOKEN_FILE))).access_token:z.string().min(1).parse(config.OPENAI_API_KEY);
 phase="connect_and_response";
 const pool=new ResponseSocketPool(new OpenAI({apiKey:token,maxRetries:0,timeout:30000}),{requestTimeoutMs:30000});
 try{
  for(let turn=1;turn<=config.PROBE_TURNS;turn++){
   const started=performance.now();
   const response=await pool.respond({model:'gpt-6-astra',reasoning:{effort:'low'},service_tier:'default',stream:true,store:false,tools:[],parallel_tool_calls:false,include:['reasoning.encrypted_content'],...(config.PROBE_MODE==='api'?{max_output_tokens:128}:{}),input:[{role:'user',content:'Reply exactly STANDARD-WS-731 and nothing else.'}]},AbortSignal.timeout(30000));
   console.log(JSON.stringify({verified_at:new Date().toISOString(),mode:config.PROBE_MODE,transport:'websocket',turn,full_history:true,previous_response_id_used:false,requested_model:'gpt-6-astra',returned_model:response.model,requested_tier:'default',returned_tier:response.service_tier??null,reasoning_effort:'low',status:response.status,correct:response.output_text.trim()==='STANDARD-WS-731',response_ms:Math.round(performance.now()-started),usage:response.usage?{input_tokens:response.usage.input_tokens,output_tokens:response.usage.output_tokens,total_tokens:response.usage.total_tokens}:null}));
   if(response.output_text.trim()!=='STANDARD-WS-731')throw new ProbeError('incorrect_marker');
  }
 }finally{pool.close();}
}
try{await main();}catch(error){console.error(JSON.stringify({event:'standard_ws_probe_failed',phase,...providerFailure(error),code:error instanceof ProbeError?error.code:error instanceof z.ZodError?'invalid_config_or_response':'transport_or_provider_failed'}));process.exitCode=1;}
