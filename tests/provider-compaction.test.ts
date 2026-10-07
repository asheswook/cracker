import { test, expect } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { OpenAIProvider, type ResponseInputItem } from "../packages/provider/index.ts";
import { atomicSecret } from "../packages/provider/credentials.ts";

test("compact uses app OAuth credential and default tier through real SDK HTTP without API fallback",async()=>{
  // Given a valid protected application credential and a recording HTTP endpoint.
  const dir=await mkdtemp(join(tmpdir(),"compact-oauth-")),tokenFile=join(dir,"credential.json"),requests:{path:string;authorization:string|null;body:unknown}[]=[];
  await atomicSecret(tokenFile,{issuer:"https://auth.openai.com",subject:"fixture-subject",client_id:"fixture-client",ext_agent_host_id:"fixture-host",id_token:"fixture",access_token:"fixture-oauth",refresh_token:"fixture-refresh",expires_at:Date.now()+3600000,scopes:["chatgpt.tokens.use.direct"]});
  const output:ResponseInputItem[]=[{type:"message",role:"user",content:[{type:"input_text",text:"fixture"}]},{type:"compaction",encrypted_content:"opaque-fixture"}];
  const server=Bun.serve({port:0,async fetch(request){requests.push({path:new URL(request.url).pathname,authorization:request.headers.get("authorization"),body:await request.json()});return Response.json({object:"response.compaction",output});}});
  const before=process.env["OPENAI_BASE_URL"];process.env["OPENAI_BASE_URL"]=server.url.href;
  try{
    const provider=new OpenAIProvider({mode:"chatgpt",model:"gpt-6-astra",tokenFile,apiKey:"must-not-be-used"});
    // When
    const result=await provider.compact([{role:"user",content:"fixture"}],AbortSignal.timeout(5000));
    // Then
    expect(result).toEqual(output);expect(requests).toEqual([{path:"/responses/compact",authorization:"Bearer fixture-oauth",body:{model:"gpt-6-astra",service_tier:"default",input:[{role:"user",content:"fixture"}]}}]);
    await expect(new OpenAIProvider({mode:"chatgpt",model:"gpt-6-astra",apiKey:"must-not-be-used"}).compact([],AbortSignal.timeout(5000))).rejects.toThrow("CHATGPT_TOKEN_FILE");expect(requests).toHaveLength(1);
  }finally{if(before===undefined)delete process.env["OPENAI_BASE_URL"];else process.env["OPENAI_BASE_URL"]=before;await server.stop(true);await rm(dir,{recursive:true});}
});
