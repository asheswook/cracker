import Ajv,{type ValidateFunction} from "ajv";
import Ajv2020 from "ajv/dist/2020.js";
import addFormats from "ajv-formats";
import {z} from "zod";
import type {Tool} from "openai/resources/responses/responses";
const FunctionCall=z.object({type:z.literal("function_call"),name:z.string().min(1),call_id:z.string().min(1).max(512).refine(value=>value.trim()===value&&value.length>0),arguments:z.string(),status:z.literal("completed").optional()});
const Message=z.object({type:z.literal("message"),role:z.literal("assistant"),status:z.literal("completed").optional(),phase:z.enum(["commentary","final_answer"]).nullable().optional(),content:z.array(z.discriminatedUnion("type",[z.object({type:z.literal("output_text"),text:z.string()}),z.object({type:z.literal("refusal"),refusal:z.string()})]))});
const Reasoning=z.object({type:z.literal("reasoning"),id:z.string().min(1),encrypted_content:z.string().nullable().optional()});
const Compaction=z.object({type:z.literal("compaction"),encrypted_content:z.string().min(1)});
const Envelope=z.object({status:z.literal("completed"),error:z.null().optional(),incomplete_details:z.null().optional(),output:z.array(z.discriminatedUnion("type",[FunctionCall,Message,Reasoning,Compaction])).min(1)});
export type ToolArgumentDiagnostic={readonly toolName:string;readonly category:"json_parse"|"object_shape"|"schema";readonly keyword?:string;readonly schemaPath?:string};
export class ResponsePlanError extends Error{constructor(readonly code:"invalid_response"|"invalid_tool_call"|"invalid_tool_schema"|"invalid_tool_arguments",readonly details?:ToolArgumentDiagnostic){super(code);this.name="ResponsePlanError";}}
type Plan={readonly kind:"calls"|"final"|"commentary"}|{readonly kind:"refusal";readonly text:string};
const draft7=new Ajv({strictSchema:true,strictTypes:false,addUsedSchema:false,logger:false}),draft2020=new Ajv2020({strictSchema:true,strictTypes:false,addUsedSchema:false,logger:false});
addFormats(draft7);addFormats(draft2020);
const validators=new WeakMap<object,ValidateFunction>();
function validatorFor(tool:Extract<Tool,{type:"function"}>):ValidateFunction{
 const schema=tool.parameters;
 if(!schema||schema["$async"]===true)throw new ResponsePlanError("invalid_tool_schema");
 let validate=validators.get(schema);
 if(!validate){
  try{validate=(schema["$schema"]==="https://json-schema.org/draft/2020-12/schema"?draft2020:draft7).compile(schema);validators.set(schema,validate);}
  catch(error){if(error instanceof Error)throw new ResponsePlanError("invalid_tool_schema");throw error;}
 }
 return validate;
}
function validateArguments(tool:Extract<Tool,{type:"function"}>,validate:ValidateFunction,args:string):void{
 const toolName=tool.name;let value:unknown;
 try{value=JSON.parse(args);}catch(error){if(error instanceof SyntaxError)throw new ResponsePlanError("invalid_tool_arguments",{toolName,category:"json_parse"});throw error;}
 if(!value||typeof value!=="object"||Array.isArray(value))throw new ResponsePlanError("invalid_tool_arguments",{toolName,category:"object_shape"});
 if(!validate(value)){
  const first=validate.errors?.[0];
  throw new ResponsePlanError("invalid_tool_arguments",{toolName,category:"schema",...(first?{keyword:first.keyword.slice(0,80),schemaPath:first.schemaPath.slice(0,512)}:{})});
 }
}
export function planResponse(response:unknown,tools:readonly Tool[],priorCallIds:ReadonlySet<string>=new Set()):Plan{
 const parsed=Envelope.safeParse(response);
 if(!parsed.success)throw new ResponsePlanError("invalid_response");
 const offered=new Map(tools.flatMap(tool=>tool.type==="function"?[[tool.name,tool] as const]:[]));
 const calls=new Set<string>();let commentary=false,final=false;const refusals:string[]=[];
 const argumentChecks:{readonly tool:Extract<Tool,{type:"function"}>;readonly arguments:string}[]=[];
 for(const item of parsed.data.output){
  switch(item.type){
   case "reasoning":case "compaction":break;
   case "function_call":{
    const tool=offered.get(item.name);
    if(!tool||calls.has(item.call_id)||priorCallIds.has(item.call_id))throw new ResponsePlanError("invalid_tool_call");
    calls.add(item.call_id);argumentChecks.push({tool,arguments:item.arguments});break;
   }
   case "message":
    for(const part of item.content){
     if(part.type==="refusal")refusals.push(part.refusal.trim()||"The provider declined this task.");
     else if(part.text.trim()){if(item.phase==="commentary")commentary=true;else final=true;}
    }break;
   default:unreachable(item);
  }
 }
 const compiledChecks=argumentChecks.map(check=>({...check,validate:validatorFor(check.tool)}));
 for(const check of compiledChecks)validateArguments(check.tool,check.validate,check.arguments);
 if(refusals.length)return {kind:"refusal",text:refusals.join("\n")};
 if(calls.size)return {kind:"calls"};
 if(final)return {kind:"final"};
 if(commentary)return {kind:"commentary"};
 throw new ResponsePlanError("invalid_response");
}
function unreachable(value:never):never{throw new TypeError(`Unsupported response item ${String(value)}`);}
