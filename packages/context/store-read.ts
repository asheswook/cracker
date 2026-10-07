import { z } from "zod";
import { hashToken } from "../../services/control/auth";
import type { Query } from "../../services/control/db";
import { DomainError } from "../protocol";
import { sourceBatch, requireSource, batchSourceView } from "./source-batch";
import { snapshotContextNotes } from "./store-notes-read";
import { allowsRetention } from "./store-retention";
import { type Evidence, type SourceWindow, SemanticContext, SemanticLink, SemanticSource } from "./schema";

export { ownedScope, rawSource, referenceSource, sourceScope, RawSource } from "./store-source";
export type { ContextScope } from "./store-source";
import { rawSource, referenceSource, sourceScope, type RawSource, type ContextScope } from "./store-source";

export const retentionAllowed = allowsRetention;
export async function sourceView(sql: Query, scope: ContextScope, source: z.infer<typeof RawSource>, limit = 1800) {
  const actual=await sourceScope(sql,scope.workspace,source.message_id);
  return SemanticSource.parse({ ...source, conversation_id:actual.conversation, content:source.content.slice(0,limit),truncated:source.content.length>limit,sha256:await hashToken(JSON.stringify(source)),retention_allowed:await retentionAllowed(sql,scope,source),linked_context_id:(await linked(sql,scope,source.message_id))?.context_id??null });
}
export async function sourceList(sql: Query, scope: ContextScope, ids: readonly string[], limit = 1800) {
  const records=await sourceBatch(sql,scope,ids);
  return ids.map(id=>batchSourceView(requireSource(records,id),limit));
}
export async function linked(sql: Query, scope: ContextScope, message: string) {
  const row=(await sql`SELECT * FROM assistant.semantic_context_links WHERE workspace_id=${scope.workspace} AND message_id=${message}`)[0];
  return row ? SemanticLink.parse(row) : null;
}
export async function exactEvidence(sql: Query, scope: ContextScope, evidence: readonly z.infer<typeof Evidence>[], maximumSequence: number, context?: string) {
  const sources=[];
  for (const item of evidence) {
    const source=await referenceSource(sql,scope,item.message_id);
    if(source.sequence>maximumSequence || !(source.content.includes(item.quote)||source.attachments.some(file=>file.name===item.quote))) throw new DomainError("invalid_evidence","Exact source text or complete attachment filename required",409);
    if(context && !(await sql`SELECT 1 FROM assistant.semantic_context_links WHERE workspace_id=${scope.workspace} AND context_id=${context} AND message_id=${item.message_id}`)[0]) throw new DomainError("invalid_evidence","Note evidence must belong to this context",409);
    sources.push(source);
  }
  return sources;
}
export async function contextSnapshot(sql: Query, scope: ContextScope, id: string, through = Number.MAX_SAFE_INTEGER, noteIds:readonly string[] = [], sourceIds:readonly string[] = [], windows:readonly z.infer<typeof SourceWindow>[] = []) {
  const row=(await sql`SELECT id AS context_id,title,scope,revision,source_sequence,initiating_message_id FROM assistant.semantic_contexts WHERE workspace_id=${scope.workspace} AND id=${id}`)[0];
  if(!row) throw new DomainError("not_found","Context not found in this workspace",404);
  const base=z.object({context_id:z.uuid(),title:z.string(),scope:z.string(),revision:z.number(),source_sequence:z.coerce.number(),initiating_message_id:z.uuid()}).parse(row);
  const firstRow=(await sql`SELECT l.message_id FROM assistant.semantic_context_links l JOIN assistant.messages m ON m.workspace_id=l.workspace_id AND m.id=l.message_id WHERE l.workspace_id=${scope.workspace} AND l.context_id=${id} AND l.source_sequence<=${through} ORDER BY (m.role='user') DESC,l.source_sequence LIMIT 1`)[0];
  if(!firstRow)return SemanticContext.parse({...base,title:'Later context',scope:'Context details are beyond this historical source',source_sequence:0,notes:[],recent_messages:[],files:[]});
  const firstScope=await sourceScope(sql,scope.workspace,z.object({message_id:z.uuid()}).parse(firstRow).message_id);
  const first=await rawSource(sql,firstScope,z.object({message_id:z.uuid()}).parse(firstRow).message_id);
  const firstLinked=(await linked(sql,scope,first.message_id))?.context_id===id;
  const pair=await sql`SELECT id FROM assistant.messages WHERE workspace_id=${scope.workspace} AND conversation_id=${firstScope.conversation} AND task_id=${first.task_id} AND role='assistant' AND sequence<=${through} AND sequence>${first.sequence} AND sequence<COALESCE((SELECT min(sequence) FROM assistant.messages WHERE workspace_id=${scope.workspace} AND conversation_id=${firstScope.conversation} AND task_id=${first.task_id} AND role='user' AND sequence>${first.sequence}),9223372036854775807) ORDER BY sequence LIMIT 1`;
  const recent=await sql`SELECT message_id AS id FROM assistant.semantic_context_links WHERE workspace_id=${scope.workspace} AND context_id=${id} AND source_sequence<=${through} ORDER BY source_sequence DESC LIMIT 4`;
  const selected=await sql`SELECT message_id AS id FROM assistant.semantic_context_links WHERE workspace_id=${scope.workspace} AND context_id=${id} AND source_sequence<=${through} AND message_id=ANY(${sql.array([...new Set([...sourceIds,...windows.map(window=>window.message_id)])])}::uuid[])`;
  const ids=[...new Set([...(firstLinked?[first.message_id]:[]),...z.array(z.object({id:z.uuid()})).parse([...pair,...recent,...selected]).map(item=>item.id)])];
  const messages:z.infer<typeof SemanticSource>[]=[];
  const records=await sourceBatch(sql,scope,ids);
  for(const message of ids.map(id=>batchSourceView(requireSource(records,id)))) {
    const record=requireSource(records,message.message_id),membership=record.link;
    if(message.sequence<=through&&message.retention_allowed&&((membership?.context_id===id&&membership.source_sha256===message.sha256)||(!membership&&firstLinked&&message.role==='assistant'&&pair.some(row=>row['id']===message.message_id)))) {
      const window=windows.find(item=>item.message_id===message.message_id);
      if(window) {
        const raw=record.raw,start=Math.min(window.start,raw.content.length),end=Math.min(window.end,raw.content.length);
        messages.push({...message,content:raw.content.slice(start,end),content_offset:start,truncated:start>0||end<raw.content.length});
      } else messages.push(message);
    }
  }
  messages.sort((a,b)=>a.sequence-b.sequence);
  const visible=await snapshotContextNotes(sql,scope,{context_id:id,through,note_ids:noteIds});
  const retrieval={note_ids:noteIds.filter(note=>visible.some(item=>item.id===note)),source_windows:windows.flatMap(window=>{
    const message=messages.find(item=>item.message_id===window.message_id);
    return message?.content.length?[{message_id:message.message_id,start:message.content_offset,end:message.content_offset+message.content.length}]:[];
  })};
  const files=[...new Map(messages.flatMap(message=>message.attachments).map(file=>[file.id,file])).values()];
  const metadata=messages.some(message=>message.message_id===base.initiating_message_id)?{title:base.title,scope:base.scope}:{title:'Context',scope:'Current retained sources and notes'};
  return SemanticContext.parse({...base,...metadata,source_sequence:Math.max(0,...messages.map(message=>message.sequence),...visible.map(note=>note.source_sequence)),notes:visible,recent_messages:messages,files,retrieval});
}

const SourcePage=z.object({context_id:z.uuid(),through:z.number().int().nonnegative().default(Number.MAX_SAFE_INTEGER),after_sequence:z.number().int().nonnegative().default(0),limit:z.number().int().min(1).max(32).default(32)}).strict();
export async function retainedContextSources(sql:Query,scope:ContextScope,input:z.input<typeof SourcePage>) {
  const page=SourcePage.parse(input);
  const rows=z.array(z.object({message_id:z.uuid(),source_sequence:z.coerce.number(),source_sha256:z.string()})).parse(await sql`SELECT message_id,source_sequence,source_sha256 FROM assistant.semantic_context_links WHERE workspace_id=${scope.workspace} AND context_id=${page.context_id} AND source_sequence>${page.after_sequence} AND source_sequence<=${page.through} ORDER BY source_sequence LIMIT ${page.limit+1}`);
  const selected=rows.slice(0,page.limit),sources=[];
  const records=await sourceBatch(sql,scope,selected.map(row=>row.message_id));
  for(const row of selected) {
    const record=requireSource(records,row.message_id),source=batchSourceView(record,record.raw.content.length);
    if(source.retention_allowed&&source.linked_context_id===page.context_id&&source.sha256===row.source_sha256)sources.push(source);
  }
  return {sources,next_after_sequence:rows.length>page.limit?(selected.at(-1)?.source_sequence??null):null};
}
