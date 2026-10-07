import {HTTPError,type KyInstance} from "ky";
import {z} from "zod";
import {ComposingReceipt,type ComposingRequest} from "../../packages/protocol/composing";
import type {ProviderResponseEvent,ProviderResponseObserver,ResponseInputItem} from "../../packages/provider";

const Source=z.object({source_message_id:z.uuid(),source_role:z.enum(["user","system","assistant"])});
export function sourceInputIds(input:readonly ResponseInputItem[]):string[]{
  const ids=new Set<string>();
  for(const item of input){
    if(!("role" in item)||item.role!=="system"||!("content" in item)||typeof item.content!=="string"||!item.content.startsWith('{"source_message_id"'))continue;
    try{
      const source=Source.safeParse(JSON.parse(item.content));
      if(source.success&&source.data.source_role!=="assistant")ids.add(source.data.source_message_id);
    }catch(error){if(!(error instanceof SyntaxError))throw error;}
  }
  return [...ids].slice(-100);
}
export async function observeComposing(http:KyInstance,run:string,input:readonly ResponseInputItem[],signal:AbortSignal,appliedInputIds?:readonly string[]){
  const ids=new Set(appliedInputIds??sourceInputIds(input));
  const inference=crypto.randomUUID();
  let generation:number,handoff:boolean;
  try{
    const receipt=ComposingReceipt.parse(await http.post("v1/daemon/composing",{json:{kind:"begin",run_id:run,inference_id:inference,input_message_ids:[...ids].slice(-100)},timeout:500,retry:0,signal}).json());
    generation=receipt.generation;handoff=receipt.reply_handoff===true;
  }catch(error){if(signal.aborted)throw error;if(!(error instanceof Error))throw error;return {observer:undefined,deliver:async(_eventId:string)=>{},close:async()=>{}};}
  let sequence=0,lastSent=0,ended=false,disposed=false;
  let pending:Extract<ComposingRequest,{kind:"update"}>|undefined;
  let flight:Promise<void>|undefined;
  const legacyIdle=(event:Extract<ComposingRequest,{kind:"update"}>):Extract<ComposingRequest,{kind:"update"}>=>({kind:"update",run_id:event.run_id,inference_id:event.inference_id,generation:event.generation,sequence:event.sequence,status:"idle",response_id:event.response_id,item_id:event.item_id,occurred_at:event.occurred_at});
  const drain=async()=>{
    while(pending){
      const event=!handoff&&(pending.status==="settling"||pending.status==="delivering")?legacyIdle(pending):pending;pending=undefined;
      try{await http.post("v1/daemon/composing",{json:event,timeout:500,retry:0});}
      catch(error){
        if(error instanceof HTTPError&&error.response.status===400&&(event.status==="settling"||event.status==="delivering")){
          handoff=false;
          try{await http.post("v1/daemon/composing",{json:legacyIdle(event),timeout:500,retry:0});}
          catch(fallbackError){if(!(fallbackError instanceof Error))throw fallbackError;}
        }else if(!(error instanceof Error))throw error;
      }
    }
  };
  const start=()=>{flight=drain().finally(()=>{flight=undefined;if(pending)start();});};
  const enqueue=(event:ProviderResponseEvent,status:"composing"|"idle"|"ended"|"settling")=>{
    const identity={kind:"update" as const,run_id:run,inference_id:inference,generation,sequence:++sequence,response_id:event.response_id,occurred_at:new Date().toISOString()};
    if(status==="settling"){
      if(event.type==="response_done")return;
      pending={...identity,status,item_id:event.item_id};
    }else pending={...identity,status,item_id:event.type==="response_done"?null:event.item_id};
    if(!flight)start();
  };
  let latest:ProviderResponseEvent|undefined;
  let completed:Exclude<ProviderResponseEvent,{type:"response_done"}>|undefined;
  let completedAt="";
  const observer:ProviderResponseObserver=event=>{
    if(disposed||ended)return;
    latest=event;
    switch(event.type){
      case "text_delta":
        if(signal.aborted)return;
        completed=undefined;
        if(Date.now()-lastSent>=1000){lastSent=Date.now();enqueue(event,"composing");}
        break;
      case "text_done":lastSent=0;completed=event;completedAt=new Date().toISOString();enqueue(event,handoff?"settling":"idle");break;
      case "response_done":ended=true;if(!handoff||!completed)enqueue(event,"ended");break;
      default:{const exhaustive:never=event;throw new TypeError(String(exhaustive));}
    }
  };
  const stop=()=>{
    if(!disposed){
      disposed=true;
      enqueue({type:"response_done",response_id:latest?.response_id??inference},"ended");
    }
  };
  signal.addEventListener("abort",stop,{once:true});
  if(signal.aborted)stop();
  const close=async()=>{
    signal.removeEventListener("abort",stop);
    stop();
    while(flight)await flight;
  };
  const deliver=async(eventId:string)=>{
    if(disposed)return;
    if(!handoff||!completed){await close();return;}
    while(flight)await flight;
    if(disposed)return;
    pending={kind:"update",run_id:run,inference_id:inference,generation,sequence:++sequence,status:"delivering",response_id:completed.response_id,item_id:completed.item_id,delivery_event_id:eventId,occurred_at:completedAt};
    start();
    while(flight)await flight;
  };
  return {observer,deliver,close};
}
