import { terminalClaim } from './claims-extraction';
export type LedgerTombstone={current_status:string;evidence:{message_id:string;source_sha256:string;start:number;end:number;quote:string}};
export type PacketClaimSpan={message_id:string;sha256:string;start:number;end:number;quote:string};
/** Exact-origin firewall only: it intentionally makes no semantic paraphrase guarantee. */
export function tombstoneFilter(spans:readonly (PacketClaimSpan|string)[],ledgerSnapshot:readonly LedgerTombstone[]){
 const retired=ledgerSnapshot.filter(c=>terminalClaim(c.current_status)||c.current_status==='superseded');
 return spans.map((span,index)=>({index,retired:retired.some(({evidence:e})=>typeof span==='string'?span.includes(e.quote):span.message_id===e.message_id&&(span.sha256!==e.source_sha256||span.start<e.end&&span.end>e.start))})).filter(item=>item.retired).map(item=>item.index);
}
export function filterRetiredClaims<T extends {items:readonly {answers:readonly PacketClaimSpan[]}[]}>(packet:T,ledgerSnapshot:readonly LedgerTombstone[]){
 let redacted=0;
  const items=packet.items.map(item=>{const denied=new Set(tombstoneFilter(item.answers,ledgerSnapshot));redacted+=denied.size;return {...item,answers:item.answers.filter((_,i)=>!denied.has(i)).map(span=>ledgerSnapshot.some(c=>c.current_status==='challenged'&&c.evidence.message_id===span.message_id&&(c.evidence.source_sha256!==span.sha256||span.start<c.evidence.end&&span.end>c.evidence.start))?{...span,claim_status:'challenged' as const}:span)};});
 return {packet:{...packet,items},redacted};
}
