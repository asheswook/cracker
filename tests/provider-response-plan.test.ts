import {test,expect} from "bun:test";
import {planResponse,ResponsePlanError} from "../packages/provider/response-plan.ts";
import {proactiveTools} from "../services/daemon/proactive.ts";
import type {Tool} from "../packages/provider/index.ts";
const echo:Tool={type:'function',name:'echo',strict:true,parameters:{$schema:'http://json-schema.org/draft-07/schema#',type:'object',properties:{text:{type:'string'}},required:['text'],additionalProperties:false}};
const call={type:'function_call',call_id:'call1',name:'echo',arguments:'{"text":"ok"}'};
const response=(output:unknown[])=>({status:'completed',error:null,output});
function rejected(output:unknown[],tools:readonly Tool[]=[echo],prior:ReadonlySet<string>=new Set()):ResponsePlanError{
 try{planResponse(response(output),tools,prior);}catch(error){if(error instanceof ResponsePlanError)return error;throw error;}
 throw new Error('Expected response rejection');
}
for(const [args,category] of [['{"secret":"private-value",','json_parse'],['[]','object_shape'],['{"text":123,"private-value":true}','schema']] as const)test(`invalid arguments expose ${category} without argument values`,()=>{
 // Given / When
 const error=rejected([{...call,arguments:args}]);
 // Then
 expect(error.code).toBe('invalid_tool_arguments');
 expect(error.details?.toolName).toBe('echo');expect(error.details?.category).toBe(category);
 expect(JSON.stringify(error)).not.toContain('private-value');
});
test('schema diagnostic points at schema rather than attacker-controlled instance property',()=>{
 // Given
 const dictionary:Tool={type:'function',name:'dictionary',strict:true,parameters:{type:'object',additionalProperties:{type:'number'}}};
 // When
 const error=rejected([{...call,name:'dictionary',arguments:'{"private-value":"secret"}'}],[dictionary]);
 // Then
 expect(error.details).toEqual({toolName:'dictionary',category:'schema',keyword:'type',schemaPath:'#/additionalProperties/type'});
 expect(JSON.stringify(error)).not.toContain('private-value');expect(JSON.stringify(error)).not.toContain('secret');
});
for(const next of [{...call},{...call,call_id:'second',name:'unknown'},{...call,call_id:'prior'}])test(`invalid arguments do not mask unsafe later call ${next.call_id}/${next.name}`,()=>{
 // Given / When
 const error=rejected([{...call,arguments:'{'},next],[echo],new Set(['prior']));
 // Then
 expect(error.code).toBe('invalid_tool_call');expect(error.details).toBeUndefined();
});
test('invalid arguments do not mask invalid schema of another offered call',()=>{
 // Given
 const broken:Tool={type:'function',name:'broken',strict:true,parameters:{$async:true,type:'object'}};
 // When
 const error=rejected([{...call,arguments:'{'},{...call,call_id:'second',name:'broken'}],[echo,broken]);
 // Then
 expect(error.code).toBe('invalid_tool_schema');
});
test('draft7 function parameters and Zod2020 UUID/date-time parameters both validate',()=>{
 // Given / When
 const draft7=planResponse(response([call]),[echo]);
 const modern=planResponse(response([{type:'function_call',call_id:'call2',name:'create_schedule',arguments:JSON.stringify({source_message_id:crypto.randomUUID(),source_quote:'one future reminder',objective:'remind once',due_at:new Date().toISOString(),timezone:'UTC'})}]),proactiveTools);
 // Then
 expect(draft7.kind).toBe('calls');expect(modern.kind).toBe('calls');
});
for(const output of [
 [{...call,status:'in_progress'}],
 [{type:'message',role:'assistant',status:'completed',phase:'unexpected',content:[{type:'output_text',text:'not final'}]}],
 [{type:'message',role:'assistant',status:'in_progress',phase:'final_answer',content:[{type:'output_text',text:'unfinished'}]}],
 [{type:'reasoning',id:'reasoning1',encrypted_content:'opaque'}],
 [{...call,call_id:' call1 '}],
])test('rejects incomplete or non-actionable output before dispatch '+JSON.stringify(output),()=>{
 // Given / When / Then
 expect(()=>planResponse(response(output),[echo])).toThrow();
});
test('previously consumed call ID cannot reappear in a later model response',()=>{
 // Given / When / Then
 expect(()=>planResponse(response([call]),[echo],new Set(['call1']))).toThrow('invalid_tool_call');
});
test('phase-absent legacy answer remains terminal alongside explicit commentary',()=>{
 // Given / When
 const plan=planResponse(response([{type:'message',role:'assistant',content:[{type:'output_text',text:'progress'}],phase:'commentary'},{type:'message',role:'assistant',content:[{type:'output_text',text:'legacy final'}]}]),[]);
 // Then
 expect(plan.kind).toBe('final');
});
