import {OpenAIProvider} from '../packages/provider/index.ts';
import {providerFailure,socketDiagnostic} from '../packages/provider/diagnostic.ts';
import OpenAI from 'openai';
const tokenFile=process.env['CHATGPT_TOKEN_FILE'];
if(!tokenFile)throw new Error('CHATGPT_TOKEN_FILE required');
for(const model of ['gpt-6-luna','gpt-6.1-sol']){
 const provider=new OpenAIProvider({mode:'chatgpt',transport:'http',model,reasoningEffort:'low',serviceTier:'default',tokenFile});
 const start=performance.now();
 try{
  const response=await provider.respond([{role:'user',content:'Reply with exactly MODEL-OK-731 and nothing else.'}],[],AbortSignal.timeout(30000));
  const text=response.output.flatMap(item=>item.type==='message'?item.content.flatMap(content=>content.type==='output_text'?[content.text]:[]):[]).join('');
  console.log(JSON.stringify({at:new Date().toISOString(),requested_model:model,returned_model:response.model,requested_tier:'default',returned_tier:response.service_tier,status:response.status,correct:text.trim()==='MODEL-OK-731',elapsed_ms:Math.round(performance.now()-start),usage:response.usage?{input_tokens:response.usage.input_tokens,output_tokens:response.usage.output_tokens,total_tokens:response.usage.total_tokens}:null}));
 }catch(error){console.log(JSON.stringify({at:new Date().toISOString(),requested_model:model,requested_tier:'default',status:'failed',elapsed_ms:Math.round(performance.now()-start),diagnostic:{...providerFailure(error),...(error instanceof OpenAI.APIError?{...socketDiagnostic({error:error.error}),http_status:error.status??null}:{})}}));}
 finally{provider.close();}
}
