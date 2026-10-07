import { z } from 'zod';
import { hybridEnabled } from './native-hybrid';
import { ReaderSnapshot } from './native-reader-protocol';
import type { ReaderSnapshotValue } from './native-reader-protocol';
const Packet = z.object({ method: z.literal('panelTransition'), kind: z.enum(['begin','source','finish','cancel']), version: z.union([z.literal(2), z.literal(3), z.literal(4)]), source: z.literal('menu').optional(), document: z.uuid(), generation: z.number().int().positive(), target: z.enum(['panel','chat','menu']), reader: ReaderSnapshot.optional() });
const Reply = z.object({ ok: z.boolean(), stage: z.enum(['waiting','covered']).optional(), error: z.string().optional() });
type Target = 'panel' | 'chat' | 'menu';
type Post = (packet: Readonly<Record<string, unknown>>) => Promise<unknown>;
type Pending = { generation: number; target: Target; accepted: boolean; beginning: boolean; finishing: boolean;
  proof?: ReaderSnapshotValue; mutate: () => void; settle: () => void; timer: ReturnType<typeof setTimeout> };
export class PanelTransition {
  private generation = 0;
  private pending: Pending | undefined;
  readonly document = crypto.randomUUID();
  constructor(private readonly post: Post, private readonly requestSource: () => void = () => {}) {}
  private packet(kind: 'begin'|'source'|'finish'|'cancel', generation: number, target: Target, proof?: ReaderSnapshotValue, source: 'chat' | 'menu' = 'chat') {
    return { method:'panelTransition',kind,version:target==='menu'?4:source==='menu'?3:2,...(source==='menu'?{source}:{}),document:this.document,generation,target,...(proof?{reader:proof}:{}) };
  }
  private abandon() {
    const previous=this.pending;this.pending=undefined;
    if(previous){clearTimeout(previous.timer);previous.settle();}
  }
  private commit(pending: Pending, covered: boolean) {
    if(this.pending!==pending)return;
    clearTimeout(pending.timer);pending.accepted=covered;pending.beginning=false;
    if(!covered)this.pending=undefined;
    pending.mutate();pending.settle();
  }
  request(target: Target, mutate: () => void, source: 'chat' | 'menu' = 'chat'): Promise<void> {
    this.abandon();const generation=++this.generation;
    return new Promise<void>(settle=>{
      const pending:Pending={generation,target,accepted:false,beginning:true,finishing:false,mutate,settle,
        timer:setTimeout(()=>{
          if(this.pending!==pending)return;
          const cancelGeneration=++this.generation;
          void this.post(this.packet('cancel',cancelGeneration,target)).catch(()=>{console.warn('[panel-transition] Timed-out source cancellation unavailable.');});
          this.commit(pending,false);
        },4500)};
      this.pending=pending;
      void this.post(this.packet('begin',generation,target,undefined,source)).then(value=>{
        if(this.pending!==pending)return;
        const reply=Reply.parse(value);
        if(!reply.ok){if(reply.error==='cancelled')this.abandon();else this.commit(pending,false);return;}
        if(reply.stage==='covered'){this.commit(pending,true);return;}
        if(reply.stage!=='waiting'){this.commit(pending,false);return;}
        pending.beginning=false;this.requestSource();this.sourceReady(pending.proof);
      }).catch(()=>this.commit(pending,false));
    });
  }
  hasAcceptedCover(target: Target) { return this.pending?.accepted===true && this.pending.target===target; }
  acceptedCoverCleanup(target: Target) {
    const pending=this.pending;
    if(!pending?.accepted||pending.target!==target)return;
    return ()=>{if(this.pending===pending)this.cancel();};
  }
  sourceReady(proof?:ReaderSnapshotValue) {
    const pending=this.pending;
    if(!pending||(pending.target!=='panel'&&pending.target!=='menu')||pending.accepted)return;
    if(proof)pending.proof=proof;
    if(pending.beginning||pending.finishing||!pending.proof)return;
    pending.finishing=true;const revision=pending.proof.revision;
    void this.post(this.packet('source',pending.generation,pending.target,pending.proof)).then(value=>{
      if(this.pending!==pending)return;
      const reply=Reply.parse(value);pending.finishing=false;
      if(reply.error==='cancelled'){this.abandon();return;}
      if(!reply.ok && reply.error!=='reader_pending'){this.commit(pending,false);return;}
      if(reply.ok&&reply.stage==='covered'){this.commit(pending,true);return;}
      if(pending.proof?.revision!==revision)this.sourceReady();
    }).catch(()=>this.commit(pending,false));
  }
  complete(target:Target,proof?:ReaderSnapshotValue){
    const pending=this.pending;
    if(!pending||!pending.accepted||pending.target!==target)return;
    if(proof)pending.proof=proof;
    if(pending.finishing||(target==='chat'&&!pending.proof))return;
    pending.finishing=true;const revision=pending.proof?.revision;
    void this.post(this.packet('finish',pending.generation,target,pending.proof)).then(value=>{
      if(this.pending!==pending)return;
      if(Reply.parse(value).ok)this.abandon();
      else{pending.finishing=false;if(pending.proof?.revision!==revision)this.complete(target);}
    }).catch(()=>{if(this.pending===pending)this.abandon();});
  }
  invalidate(document:string,generation:number){if(document===this.document&&generation===this.pending?.generation){this.generation++;this.abandon();}}
  cancel(){this.abandon();const generation=++this.generation;
    void this.post(this.packet('cancel',generation,'chat')).catch(()=>{console.warn('[panel-transition] Cancellation could not reach native host.');});
  }
}
let transition:PanelTransition|undefined;
export function panelTransition(){
  if(!hybridEnabled()||document.documentElement.dataset.rootScrollTrial!=='true'||!matchMedia('(max-width:999px)').matches||!window.webkit?.messageHandlers?.assistantNative)return undefined;
  if(transition)return transition;
  transition=new PanelTransition(async packet=>{
    const bridge=window.webkit?.messageHandlers?.assistantNative;
    if(!bridge)throw new Error('panel_bridge_unavailable');
    let timer:ReturnType<typeof setTimeout>|undefined;
    try{return await Promise.race([bridge.postMessage(Packet.parse(packet)),new Promise<never>((_,reject)=>{timer=setTimeout(()=>reject(new Error('panel_bridge_timeout')),3500);})]);}
    finally{clearTimeout(timer);}
  },()=>window.dispatchEvent(new Event('assistant-panel-source-request')));
  window.addEventListener('assistant-panel-transition-cancel',event=>{
    if(!(event instanceof CustomEvent))return;
    const value=z.object({document:z.uuid(),generation:z.number().int().positive()}).safeParse(event.detail);
    if(value.success)transition?.invalidate(value.data.document,value.data.generation);
  });
  window.addEventListener('assistant-root-reader-disable',()=>transition?.cancel());
  document.addEventListener('visibilitychange',()=>{if(document.hidden)transition?.cancel();});
  return transition;
}
