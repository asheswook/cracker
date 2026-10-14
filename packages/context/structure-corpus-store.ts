import { z } from 'zod';
import { hashToken, type Principal } from '../../services/control/auth';
import type { Database } from '../../services/control/db';
import { DomainError } from '../protocol';
import { ownedScope, rawSource, retentionAllowed } from './store-read';
import { sourceBatch } from './source-batch';
import { Exchange, Edge } from './structure-schema';
import type { StructureSource } from './structure-corpus';

export async function readStructureCorpus(sql:Database,principal:Principal,run:string,message:string) {
 return sql.begin(async tx=>{
  await tx`SET TRANSACTION ISOLATION LEVEL REPEATABLE READ READ ONLY`;
  const owner=await ownedScope(tx,principal,run,false,'backfill'),scope={workspace:principal.workspace_id,conversation:owner.conversation_id};
  const child=Exchange.parse((await tx`SELECT * FROM assistant.semantic_exchanges WHERE workspace_id=${scope.workspace} AND conversation_id=${scope.conversation} AND user_message_id=${message}`)[0]);
  const current=await rawSource(tx,scope,message);
  if(current.task_id!==owner.task_id||!await retentionAllowed(tx,scope,current))throw new DomainError('retention_denied','Current source unavailable',409);
  const recent=z.array(Exchange).parse(await tx`SELECT * FROM assistant.semantic_exchanges WHERE workspace_id=${scope.workspace} AND conversation_id=${scope.conversation} AND sequence<${child.sequence} ORDER BY sequence DESC LIMIT 64`);
  const memberRows=recent.length?z.array(z.object({exchange_id:z.uuid(),message_id:z.uuid(),kind:z.enum(['answer','progress'])})).parse(await tx`SELECT member.exchange_id,member.message_id,member.kind FROM assistant.semantic_exchange_members member JOIN assistant.messages m ON m.workspace_id=member.workspace_id AND m.id=member.message_id WHERE member.workspace_id=${scope.workspace} AND member.exchange_id=ANY(${tx.array(recent.map(e=>e.id))}::uuid[]) AND member.kind IN ('answer','progress') AND m.sequence<${child.sequence} ORDER BY m.sequence DESC`):[];
  const batch=await sourceBatch(tx,scope,[...recent.map(e=>e.user_message_id),...memberRows.map(m=>m.message_id)]);
  const sources:StructureSource[]=[],exchanges:z.infer<typeof Exchange>[]=[];
  let bytes=0;
  for(const exchange of recent){
   const user=batch.get(exchange.user_message_id);
   if(!user||!user.retentionAllowed)continue;
   exchanges.push(exchange);
   const members=memberRows.filter(m=>m.exchange_id===exchange.id).slice(0,4);
   for(const item of [{message_id:user.raw.message_id,kind:'user' as const},...members]){
    if(sources.length>=256)break;
    const record=batch.get(item.message_id);
    if(!record||record.raw.sequence>=child.sequence||!record.retentionAllowed)continue;
    // Skip oversized sources rather than silently altering exact quote coordinates.
    const size=Buffer.byteLength(record.raw.content);
    if(size>100000||bytes+size>512000)continue;
    bytes+=size;sources.push({...record.raw,exchange_id:exchange.id,kind:item.kind,sha256:record.sha256});
   }
  }
  const ids=[child.id,...exchanges.map(e=>e.id)];
  const edges=z.array(Edge).parse(await tx`SELECT * FROM assistant.semantic_exchange_edges WHERE workspace_id=${scope.workspace} AND child_exchange_id=ANY(${tx.array(ids)}::uuid[]) AND NOT needs_revalidation AND status<>'rejected' ORDER BY child_exchange_id,role,slot LIMIT 256`);
  const result={workspace_id:scope.workspace,conversation_id:scope.conversation,child,current:{...current,exchange_id:child.id,kind:'user' as const,sha256:await hashToken(JSON.stringify(current))},sources,exchanges,edges};
  return {...result,version:await hashToken(JSON.stringify(result))};
 });
}
