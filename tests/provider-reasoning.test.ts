import {test,expect} from "bun:test";
import {z} from "zod";
import {OpenAIProvider} from "../packages/provider/index.ts";
for(const effort of [undefined,"low"] as const)test(`actual Responses request ${effort??'unset'} reasoning preserves explicit configuration`,async()=>{
 // Given a real HTTP endpoint that records the SDK request and returns a completed SSE response.
 let request:unknown;
 const server=Bun.serve({port:0,async fetch(req){request=await req.json();return new Response(`data: ${JSON.stringify({type:'response.completed',response:{id:'fixture',status:'completed',output:[{type:'message',id:'msg',role:'assistant',status:'completed',content:[{type:'output_text',text:'ok',annotations:[]}]}]}})}\n\n`,{headers:{'Content-Type':'text/event-stream'}});}});
 const previous=process.env['OPENAI_BASE_URL'];process.env['OPENAI_BASE_URL']=server.url.href;
 try{
  const provider=new OpenAIProvider({mode:'api',model:'gpt-6-astra',apiKey:'fixture-only',...(effort?{reasoningEffort:effort}:{})});
  // When
  await provider.respond([{role:'user',content:'fixture'}],[],AbortSignal.timeout(5000));
  // Then
  const body=z.object({model:z.string(),reasoning:z.object({effort:z.string()}).optional(),store:z.boolean(),stream:z.boolean(),parallel_tool_calls:z.boolean(),include:z.array(z.string()),previous_response_id:z.string().optional()}).parse(request);
  expect(body.model).toBe('gpt-6-astra');expect(body.reasoning?.effort).toBe(effort);expect(body.include).toEqual(["reasoning.encrypted_content"]);expect(body.previous_response_id).toBeUndefined();expect(body.parallel_tool_calls).toBe(true);expect(body.store).toBe(false);expect(body.stream).toBe(true);
 }finally{if(previous===undefined)delete process.env['OPENAI_BASE_URL'];else process.env['OPENAI_BASE_URL']=previous;await server.stop(true);}
});
