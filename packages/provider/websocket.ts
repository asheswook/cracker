import type OpenAI from 'openai';
import {ResponsesWS} from 'openai/resources/responses/ws';
import type {Response,ResponseCreateParamsStreaming,ResponseStreamEvent} from 'openai/resources/responses/responses';
import {z} from 'zod';
import {consumeResponse} from './stream.ts';
import type {ProviderResponseObserver} from './stream.ts';
import {ProviderError} from './errors.ts';
import {socketDiagnostic,unsupportedEventDiagnostic} from './diagnostic.ts';

const EventType=z.enum(['error','response.created','response.in_progress','response.completed','response.failed','response.incomplete','response.output_item.added','response.output_item.done','response.content_part.added','response.content_part.done','response.output_text.delta','response.output_text.done','response.output_text.annotation.added','response.refusal.delta','response.refusal.done','response.reasoning_summary_part.added','response.reasoning_summary_part.done','response.reasoning_summary_text.delta','response.reasoning_summary_text.done','response.reasoning_text.delta','response.reasoning_text.done','response.function_call_arguments.delta','response.function_call_arguments.done']);
const Envelope=z.object({type:z.string(),stream_id:z.string().optional()});
const ResponseIdentity=z.object({response:z.object({id:z.string().min(1)})});
type Slot={readonly ws:ResponsesWS;readonly openedAt:number;calls:number;readonly responseIds:Set<string>;readonly itemIds:Set<string>;busy:boolean;dead:boolean;idleTimer:ReturnType<typeof setTimeout>|undefined};
export type SocketPoolOptions={readonly lane?:"named"|"implicit";readonly idleTimeoutMs?:number;readonly requestTimeoutMs?:number};
export class ResponseSocketPool{
  private readonly slots=new Set<Slot>();
  private closed=false;
  private retired=false;
  get drained():boolean{return this.slots.size===0;}
  retire():void{this.retired=true;for(const slot of this.slots)if(!slot.busy)this.discard(slot);}
  constructor(private readonly client:OpenAI,private readonly options:SocketPoolOptions={}){}
  private discard(slot:Slot):void{
    if(slot.dead)return;
    slot.dead=true;clearTimeout(slot.idleTimer);this.slots.delete(slot);
    slot.ws.close();slot.ws.socket.platformSocket.terminate();
  }
  close():void{this.closed=true;for(const slot of this.slots)this.discard(slot);}
  private acquire():Slot{
    if(this.closed||this.retired)throw new ProviderError('configuration','WebSocket provider is closed');
    for(const slot of this.slots){
      if(slot.busy)continue;
      if(slot.dead||slot.ws.socket.readyState!==1||slot.calls>=32||performance.now()-slot.openedAt>=55*60*1000){this.discard(slot);continue;}
      clearTimeout(slot.idleTimer);slot.busy=true;return slot;
    }
    if(this.slots.size>=8)throw new ProviderError('configuration','WebSocket concurrent request limit reached');
    const ws=new ResponsesWS(this.client,{reconnect:null,maxQueueSize:32*1024*1024,maxPayload:32*1024*1024});
    const slot:Slot={ws,openedAt:performance.now(),calls:0,responseIds:new Set(),itemIds:new Set(),busy:true,dead:false,idleTimer:undefined};
    this.slots.add(slot);
    ws.on('error',error=>{const envelope=Envelope.safeParse(error.error);if(!slot.busy||!envelope.success||!envelope.data.stream_id)this.discard(slot);});
    ws.on('close',()=>this.discard(slot));
    return slot;
  }
  private release(slot:Slot):void{
    slot.busy=false;
    if(slot.dead)return;
    const idle=[...this.slots].filter(entry=>!entry.busy).length;
    if(this.closed||this.retired||idle>2||slot.calls>=32){this.discard(slot);return;}
    slot.idleTimer=setTimeout(()=>this.discard(slot),this.options.idleTimeoutMs??60000);
    slot.idleTimer.unref();
  }
  async respond(body:ResponseCreateParamsStreaming,signal:AbortSignal,observer?:ProviderResponseObserver):Promise<Response>{
    observer?.continuation?.(()=>undefined);
    signal.throwIfAborted();
    if(body.previous_response_id||body.service_tier&&body.service_tier!=='default')throw new ProviderError('configuration','WebSocket requires full history and default service tier');
    const slot=this.acquire(),streamId=crypto.randomUUID();slot.calls++;
    const events=slot.ws.stream();
    const aborted=Promise.withResolvers<never>();
    const abort=()=>{this.discard(slot);aborted.reject(new ProviderError('incomplete','WebSocket request aborted'));};
    signal.addEventListener('abort',abort,{once:true});
    const timeout=setTimeout(()=>{this.discard(slot);aborted.reject(new ProviderError('incomplete','WebSocket request timed out'));},this.options.requestTimeoutMs??120000);
    const {stream:_stream,...request}=body;
    try{
      if(signal.aborted)abort();
      else slot.ws.sendRaw(JSON.stringify({...request,type:'response.create',...(this.options.lane==="implicit"?{}:{stream_id:streamId}),store:false,service_tier:'default'}));
      const response=await Promise.race([consumeResponse(this.correlated(events,streamId,slot),observer,signal),aborted.promise]);
      if(response.service_tier&&response.service_tier!=='default')throw new ProviderError('incomplete','WebSocket returned an unexpected service tier');
      return response;
    }catch(error){
      if(!signal.aborted)observer?.continuation?.(()=>undefined);
      this.discard(slot);
      if(error instanceof ProviderError)throw error;
      throw new ProviderError('incomplete','WebSocket response failed validation or transport');
    }finally{
      clearTimeout(timeout);signal.removeEventListener('abort',abort);
      await events.return?.();this.release(slot);
    }
  }
  private async *correlated(events:ReturnType<ResponsesWS['stream']>,streamId:string,slot:Slot):AsyncGenerator<ResponseStreamEvent>{
    let responseId:string|undefined;
    const currentItems=new Map<string,number>();
    const currentIndices=new Map<number,string>();
    const implicit=this.options.lane==="implicit";
    for await(const event of events){
      switch(event.type){
        case 'error':{
          const envelope=Envelope.safeParse(event.error.error);
          if(!implicit&&envelope.success&&envelope.data.stream_id&&envelope.data.stream_id!==streamId)break;
          throw new ProviderError('incomplete','WebSocket transport failed',socketDiagnostic(event.error));
        }
        case 'close':throw new ProviderError('incomplete','WebSocket closed before completion');
        case 'message':{
          const envelope=Envelope.parse(event.message);
          if(implicit&&(envelope.type==="codex.response.metadata"||envelope.type==="responsesapi.websocket_timing"))continue;
          if(!implicit&&envelope.stream_id!==streamId){
            if(envelope.stream_id)continue;
            throw new ProviderError('incomplete','WebSocket event lacks stream correlation');
          }
          if(implicit&&envelope.stream_id)throw new ProviderError('incomplete','WebSocket unexpected named event');
          if(!EventType.safeParse(envelope.type).success)throw new ProviderError('incomplete','WebSocket event type is unsupported',unsupportedEventDiagnostic(envelope.type));
          if(event.message.type==='error')throw new ProviderError('incomplete','WebSocket request failed');
          if(implicit&&'response' in event.message){
            const id=ResponseIdentity.parse(event.message).response.id;
            if(id!==responseId&&slot.responseIds.has(id))continue;
          }
          if(implicit){
            const previousItem=z.object({item_id:z.string().optional(),item:z.object({id:z.string()}).optional()}).parse(event.message);
            const id=previousItem.item_id??previousItem.item?.id;
            if(id&&slot.itemIds.has(id)&&!currentItems.has(id))continue;
          }
          if(event.message.type==='response.created'){
            const id=ResponseIdentity.parse(event.message).response.id;
            if(responseId&&responseId!==id)throw new ProviderError('incomplete','WebSocket response identity changed');
            responseId=id;slot.responseIds.add(id);
          }else if(!responseId)throw new ProviderError('incomplete','WebSocket event preceded response identity');
          if(event.message.type==='response.completed'||event.message.type==='response.failed'||event.message.type==='response.incomplete'){
            if(ResponseIdentity.parse(event.message).response.id!==responseId)throw new ProviderError('incomplete','WebSocket terminal identity mismatch');
          }
          if(implicit){
            if(event.message.type==='response.output_item.added'||event.message.type==='response.output_item.done'){
              const value=z.object({item:z.object({id:z.string().min(1)}),output_index:z.number().int().nonnegative()}).parse(event.message);
              const id=value.item.id;
              if(slot.itemIds.has(id)&&!currentItems.has(id))continue;
              if(event.message.type==='response.output_item.added'){
                if(currentIndices.has(value.output_index)&&currentIndices.get(value.output_index)!==id||currentItems.has(id)&&currentItems.get(id)!==value.output_index)throw new ProviderError('incomplete','WebSocket output item identity mismatch');
                if(currentItems.size>=256||slot.itemIds.size>=8192)throw new ProviderError('incomplete','WebSocket output item limit exceeded');
                currentItems.set(id,value.output_index);currentIndices.set(value.output_index,id);slot.itemIds.add(id);
              }else if(currentItems.get(id)!==value.output_index)throw new ProviderError('incomplete','WebSocket output item identity mismatch');
            }else if(event.message.type==='response.completed'){
              for(const item of z.array(z.object({id:z.string()})).parse(event.message.response.output))if(!currentItems.has(item.id))throw new ProviderError('incomplete','WebSocket output item identity mismatch');
            }else if(!('response' in event.message)){
              const item=z.object({item_id:z.string().min(1)}).parse(event.message);
              if(slot.itemIds.has(item.item_id)&&!currentItems.has(item.item_id))continue;
              if(!currentItems.has(item.item_id))throw new ProviderError('incomplete','WebSocket output item identity mismatch');
            }
          }
          yield event.message;
          break;
        }
        case 'raw':throw new ProviderError('incomplete','WebSocket returned an unsupported raw frame');
        case 'connecting':case 'open':case 'closing':case 'reconnecting':case 'reconnected':break;
        default:unreachable(event);
      }
    }
  }
}
function unreachable(_value:never):never{throw new ProviderError('incomplete','Unexpected WebSocket lifecycle event');}
