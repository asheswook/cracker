import {z} from 'zod';
import type {Message} from '@anthropic-ai/sdk/resources/messages';
import type {BetaMessage} from '@anthropic-ai/sdk/resources/beta/messages/messages';
import {anthropicOutput} from './anthropic-messages.ts';
import {ProviderError} from './errors.ts';
import {NativeAssistantBlocks,type NativeContextState} from './native-context.ts';
import {nativeHash} from './anthropic-context-frames.ts';
import type {ProviderContinuation} from './continuation.ts';

/** SDK streamEvent callbacks run with the matching accumulated snapshot, before iterator backlog. */
export class AnthropicContinuation {
  private message:Message|BetaMessage|undefined;
  private readonly completed=new Set<number>();
  private invalid=false;
  private frozen=false;
  private frozenValue:ProviderContinuation|undefined;
  private readonly toolJson=new Map<number,string>();
  constructor(private readonly model:string,private readonly native?:{readonly state:NativeContextState;readonly inputLength:number}){}
  accept(event:{readonly type:string;readonly index?:number;readonly delta?:unknown},snapshot:Message|BetaMessage):void {
    if(this.frozen)return;
    if(snapshot.model!==this.model||'input_transformations' in snapshot&&snapshot.input_transformations?.length){this.invalid=true;return;}
    this.message=snapshot;
    const delta=z.object({type:z.literal("input_json_delta"),partial_json:z.string()}).safeParse(event.delta);
    if(delta.success&&event.index!==undefined)this.toolJson.set(event.index,(this.toolJson.get(event.index)??"")+delta.data.partial_json);
    if(event.type==='content_block_stop'&&event.index!==undefined)this.completed.add(event.index);
  }
  freeze=():void=>{
    if(this.frozen)return;
    this.frozenValue=this.read();
    this.frozen=true;
  };
  invalidate():void {this.invalid=true;}
  read=():ProviderContinuation|undefined=>{
    if(this.frozen)return this.frozenValue?structuredClone(this.frozenValue):undefined;
    const message=this.message;
    if(this.invalid||!message)return;
    const content:(Message["content"][number]|BetaMessage["content"][number])[]=[];
    let partialText=false;
    for(const [index,block] of message.content.entries()){
      const complete=this.completed.has(index);
      if(!complete&&(block.type!=="text"||!block.text))break;
      if(block.type==="tool_use"){
        if(!block.name.trim()||block.name.trim()!==block.name||block.id.trim()!==block.id)break;
        const json=this.toolJson.get(index);
        if(json!==undefined){
          try{if(!z.record(z.string(),z.unknown()).safeParse(JSON.parse(json)).success)break;}
          catch(error){if(error instanceof SyntaxError)break;throw error;}
        }
      }
      const parsed=NativeAssistantBlocks.safeParse([block]);
      if(!parsed.success)break;
      try{anthropicOutput({id:message.id,content:[block]},this.model,'commentary');}
      catch(error){if(error instanceof ProviderError)break;throw error;}
      content.push(structuredClone(block));
      if(!complete){partialText=true;break;}
    }
    if(!content.length)return;
    const output=anthropicOutput({id:message.id,content},this.model,'commentary');
    const last=output.at(-1);
    if(partialText&&last?.type==='message')last.status='incomplete';
    const nativeContext=this.native?{...structuredClone(this.native.state),reply:{from:this.native.inputLength,to:this.native.inputLength+output.length,hash:nativeHash(output),content:NativeAssistantBlocks.parse(content)}}:undefined;
    return {responseId:message.id,output,...(nativeContext?{nativeContext}:{})};
  };
}
