import {test,expect} from "bun:test";
import type {Response,ResponseStreamEvent,ResponseOutputMessage} from "openai/resources/responses/responses";
import {consumeResponse,type ProviderResponseEvent} from "../packages/provider/stream";
const message:ResponseOutputMessage={type:"message",id:"reply",role:"assistant",status:"completed",content:[{type:"output_text",text:"Visible answer",annotations:[]}]};
const response:Response={id:"response-1",created_at:0,output_text:"",error:null,incomplete_details:null,instructions:null,metadata:null,model:"fixture",object:"response",output:[message],parallel_tool_calls:false,temperature:null,tool_choice:"auto",tools:[],top_p:null,status:"completed"};
const created:ResponseStreamEvent={type:"response.created",response,sequence_number:0};
const added:ResponseStreamEvent={type:"response.output_item.added",item:message,output_index:0,sequence_number:1};
const delta=(text:string):ResponseStreamEvent=>({type:"response.output_text.delta",item_id:"reply",output_index:0,content_index:0,sequence_number:2,delta:text,logprobs:[]});
async function* events(items:readonly ResponseStreamEvent[]){yield*items;}
test("only actual nonempty assistant text deltas compose before response completion",async()=>{
  const seen:ProviderResponseEvent[]=[];
  const gate=Promise.withResolvers<void>(),started=Promise.withResolvers<void>();
  async function* wire(){yield created;yield {type:"response.reasoning_text.delta",item_id:"reasoning",output_index:0,content_index:0,sequence_number:1,delta:"private"} satisfies ResponseStreamEvent;yield delta("unknown item");yield added;yield delta(" ");yield delta("Visible");started.resolve();await gate.promise;yield {type:"response.output_text.done",item_id:"reply",output_index:0,content_index:0,sequence_number:3,text:"Visible",logprobs:[]} satisfies ResponseStreamEvent;yield {type:"response.completed",response,sequence_number:4} satisfies ResponseStreamEvent;}
  const result=consumeResponse(wire(),event=>seen.push(event));await started.promise;
  expect(seen).toEqual([{type:"text_delta",response_id:"response-1",item_id:"reply"}]);
  gate.resolve();await result;
  expect(seen.map(event=>event.type)).toEqual(["text_delta","text_done","response_done"]);
  expect(JSON.stringify(seen)).not.toContain("Visible");expect(JSON.stringify(seen)).not.toContain("private");
});
test("tool arguments and reasoning never start composing",async()=>{
  const seen:ProviderResponseEvent[]=[];
  await consumeResponse(events([created,{type:"response.function_call_arguments.delta",item_id:"call",output_index:0,sequence_number:1,delta:'{"command":"hello"}'},{type:"response.completed",response,sequence_number:2}]),event=>seen.push(event));
  expect(seen).toEqual([{type:"response_done",response_id:"response-1"}]);
});
for(const ending of ["error","eof"] as const)test(`response lifecycle closes composing on ${ending}`,async()=>{
  const seen:ProviderResponseEvent[]=[];
  async function* wire(){yield created;yield added;yield delta("Visible");if(ending==="error")throw new TypeError("transport aborted");}
  await expect(consumeResponse(wire(),event=>seen.push(event))).rejects.toThrow();
  expect(seen.map(event=>event.type)).toEqual(["text_delta","response_done"]);
});
