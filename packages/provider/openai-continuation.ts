import { z } from 'zod';
import type { ResponseOutputItem, ResponseStreamEvent } from 'openai/resources/responses/responses';
import type { ProviderContinuation } from './continuation.ts';

const Identity=z.object({id:z.string().min(1)});
const Envelope=z.object({type:z.string(),response_id:z.string().optional()});
const TextPart=z.object({type:z.literal('output_text'),text:z.string(),annotations:z.array(z.unknown())});
const Draft=z.object({type:z.literal('message'),id:z.string().min(1),role:z.literal('assistant'),status:z.enum(['in_progress','incomplete','completed']),content:z.array(TextPart)});
const Completed=z.discriminatedUnion('type',[
 z.object({type:z.literal('reasoning'),id:z.string().min(1),encrypted_content:z.string().min(1),summary:z.array(z.object({type:z.literal('summary_text'),text:z.string()})),status:z.literal('completed').optional()}),
 z.object({type:z.literal('message'),id:z.string().min(1),role:z.literal('assistant'),status:z.literal('completed'),content:z.array(z.discriminatedUnion('type',[
  z.object({type:z.literal('output_text'),text:z.string(),annotations:z.array(z.unknown())}),z.object({type:z.literal('refusal'),refusal:z.string()}),
 ]))}),
 z.object({type:z.literal('function_call'),id:z.string().min(1),call_id:z.string().min(1),name:z.string().min(1),arguments:z.string().refine(value=>{try{return z.record(z.string(),z.unknown()).safeParse(JSON.parse(value)).success;}catch(error){if(error instanceof SyntaxError)return false;throw error;}}),status:z.literal('completed').optional()}),
]);

export class OpenAIContinuation {
 private responseId:string|undefined;
 private valid=true;
 private frozen=false;
 private readonly drafts=new Map<number,Extract<ResponseOutputItem,{type:"message"}>>();
 private readonly identities=new Map<number,string>();
 private readonly indices=new Map<string,number>();
 private readonly completed=new Map<number,ResponseOutputItem>();
 freeze():void{this.frozen=true;}
 invalidate():void{this.valid=false;this.completed.clear();this.drafts.clear();}
 read():ProviderContinuation|undefined{
  if(!this.valid||!this.responseId)return;
  const output:ResponseOutputItem[]=[];
  for(let index=0;index<256;index++){
   const item=this.completed.get(index);
   if(item){if(!Completed.safeParse(item).success)break;output.push(item);continue;}
   const draft=this.drafts.get(index);
   if(draft?.content.some(part=>part.type==='output_text'&&part.text.length))output.push({...draft,status:'incomplete'});
   break;
  }
  if(output.length)return {responseId:this.responseId,output:structuredClone(output)};
 }
 observe(event:ResponseStreamEvent):void{
  if(!this.valid||this.frozen)return;
  const envelope=Envelope.safeParse(event);
  if(!envelope.success||envelope.data.response_id&&envelope.data.response_id!==this.responseId){this.invalidate();return;}
  if('response'in event){
   const identity=Identity.safeParse(event.response);
   if(!identity.success||this.responseId&&identity.data.id!==this.responseId){this.invalidate();return;}
   if(event.type==='response.created')this.responseId=identity.data.id;
   else if(!this.responseId){this.invalidate();return;}
  }
  if(event.type==='error'||event.type==='response.failed'||event.type==='response.incomplete'){this.invalidate();return;}
  if(event.type==='response.output_text.delta'||event.type==='response.output_text.done'||event.type==='response.content_part.added'||event.type==='response.content_part.done'){
   const draft=this.drafts.get(event.output_index);
   if(!draft)return;
   if(draft.id!==event.item_id||!Number.isSafeInteger(event.content_index)||event.content_index<0||event.content_index>draft.content.length){this.invalidate();return;}
   if(event.type==='response.content_part.added'||event.type==='response.content_part.done'){
    if(TextPart.safeParse(event.part).success&&event.part.type==='output_text')draft.content[event.content_index]=structuredClone(event.part);
    else this.drafts.delete(event.output_index);
   }else{
    const part=draft.content[event.content_index]??{type:'output_text',text:'',annotations:[]};
    if(part.type!=='output_text'){this.drafts.delete(event.output_index);return;}
    const value=event.type==='response.output_text.delta'?event.delta:event.text;
    if(typeof value!=='string'){this.invalidate();return;}
    part.text=event.type==='response.output_text.delta'?part.text+value:value;
    draft.content[event.content_index]=part;
   }
   return;
  }
  if(event.type!=='response.output_item.added'&&event.type!=='response.output_item.done')return;
  const item=Identity.safeParse(event.item),index=event.output_index;
  if(!this.responseId||!item.success||!Number.isSafeInteger(index)||index<0||index>=256){this.invalidate();return;}
  const id=item.data.id;
  if(this.identities.has(index)&&this.identities.get(index)!==id||this.indices.has(id)&&this.indices.get(id)!==index||this.completed.has(index)){this.invalidate();return;}
  this.identities.set(index,id);this.indices.set(id,index);
  if(event.type==='response.output_item.done'){this.completed.set(index,structuredClone(event.item));this.drafts.delete(index);}
  else if(event.item.type==='message'&&Draft.safeParse(event.item).success)this.drafts.set(index,structuredClone(event.item));
 }
}
