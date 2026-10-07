import { z } from 'zod';
import type { Query } from '../../services/control/db';
import { DomainError } from '../protocol';
import { contextSnapshot, linked, rawSource, sourceScope, sourceView, retentionAllowed, type ContextScope } from './store-read';

export async function replySource(sql:Query,workspace:string,id:string) {
  const scope=await sourceScope(sql,workspace,id);
  const raw=await rawSource(sql,scope,id);
  if(!await retentionAllowed(sql,scope,raw))throw new DomainError('reply_unavailable','Reply source is unavailable for context reuse',409);
  return {scope,raw,source:await sourceView(sql,scope,raw,8000)};
}

export async function messageReply(sql:Query,scope:ContextScope,message:string) {
  const row=(await sql`SELECT reply_to_message_id FROM assistant.messages WHERE workspace_id=${scope.workspace} AND id=${message}`)[0];
  const id=z.object({reply_to_message_id:z.uuid().nullable()}).parse(row).reply_to_message_id;
  if(!id)return null;
  const {source}=await replySource(sql,scope.workspace,id);
  const membership=await linked(sql,scope,id);
  if(membership&&membership.source_sha256!==source.sha256)throw new DomainError('reply_unavailable','Reply source changed since context indexing',409);
  return {source,context:membership?await contextSnapshot(sql,scope,membership.context_id,Number.MAX_SAFE_INTEGER,[],[id]):null};
}

export async function replyPreview(sql:Query,workspace:string,id:string) {
  const scope=await sourceScope(sql,workspace,id),raw=await rawSource(sql,scope,id);
  const available=await retentionAllowed(sql,scope,raw);
  return {message_id:id,conversation_id:scope.conversation,sequence:raw.sequence,role:raw.role,content:available?raw.content.slice(0,500):'',available};
}
