import { z } from 'zod';
import type { Database, Query } from '../../services/control/db';
import { hashToken } from '../../services/control/auth';
import { retainedContextSources } from './store-read';
import { retainedContextNotes } from './store-notes-read';
import { ContextRecallError, encodeContext, SearchDocument, type ContextEmbed, type SearchScope } from './recall-types';

const Head=z.object({id:z.uuid(),workspace_id:z.uuid(),conversation_id:z.uuid(),revision:z.number().int(),search_revision:z.coerce.number().int()});
type DocumentInput=Readonly<{id:string;context_id:string;kind:'source'|'note';reference_id:string;source_sequence:number;input_hash:string;start_offset:number;end_offset:number;text:string}>;
export async function contextDocumentHash(text:string) {return hashToken(text);}
export function contextChunks(text:string):ReadonlyArray<Readonly<{text:string;start:number;end:number}>> {
  const chunks=[];
  for(let start=0;start<text.length;start+=1600) {
    const end=Math.min(text.length,start+1800);
    chunks.push({text:text.slice(start,end),start,end});
    if(end===text.length)break;
  }
  return chunks;
}
async function contextDocuments(sql:Query,scope:SearchScope,context:string,through:number) {
  const documents:DocumentInput[]=[];
  const add=async(kind:'source'|'note',reference:string,sequence:number,text:string,start:number,end:number)=>{
    const input_hash=await contextDocumentHash(text);
    const id=await hashToken(`${scope.workspace}:${context}:${kind}:${reference}:${start}:${input_hash}`);
    documents.push({id,context_id:context,kind,reference_id:reference,source_sequence:sequence,input_hash,start_offset:start,end_offset:end,text});
  };
  let afterSequence=0;
  while(true) {
    const page=await retainedContextSources(sql,scope,{context_id:context,through,after_sequence:afterSequence});
    for(const source of page.sources) {
      const text=source.content||source.attachments.map(file=>file.name).join('\n');
      for(const chunk of contextChunks(text))await add('source',source.message_id,source.sequence,chunk.text,chunk.start,chunk.end);
    }
    if(page.next_after_sequence===null)break;
    afterSequence=page.next_after_sequence;
  }
  let afterId:string|undefined;
  while(true) {
    const page=await retainedContextNotes(sql,scope,{context_id:context,through,...(afterId?{after_id:afterId}:{})});
    for(const note of page.notes)await add('note',note.id,note.source_sequence,note.text,0,note.text.length);
    if(page.next_after_id===null)break;
    afterId=page.next_after_id;
  }
  return documents;
}
async function synchronizeContext(sql:Database,embed:ContextEmbed,head:z.infer<typeof Head>,through:number) {
  const scope={workspace:head.workspace_id,conversation:head.conversation_id};
  const documents=await contextDocuments(sql,scope,head.id,through);
  // Only identities are needed to find unindexed text; reading stored vectors back cost seconds per context.
  const indexed=new Set(z.array(z.object({id:z.string()})).parse(await sql`SELECT id FROM assistant.semantic_search_documents WHERE workspace_id=${scope.workspace} AND context_id=${head.id}`).map(document=>document.id));
  const cached=new Map<string,z.infer<typeof SearchDocument>>();
  const missing=documents.filter(document=>!indexed.has(document.id));
  for(let offset=0;offset<missing.length;offset+=32) {
    const batch=missing.slice(offset,offset+32),vectors=await encodeContext(embed,batch.map(document=>document.text));
    batch.forEach((document,i)=>{
      const vector=vectors[i];if(!vector)throw new ContextRecallError('invalid_embeddings');
      const stored=SearchDocument.parse({...document,vector});cached.set(document.id,stored);
    });
  }
  const ids=documents.map(document=>document.id);
  return sql.begin(async tx=>{
    const current=z.array(Head).parse(await tx`SELECT id,workspace_id,conversation_id,revision,search_revision FROM assistant.semantic_contexts WHERE workspace_id=${scope.workspace} AND id=${head.id} FOR UPDATE`)[0];
    if(!current||current.revision!==head.revision||current.search_revision!==head.search_revision)return false;
    const state=z.object({revision:z.number(),search_revision:z.coerce.number(),through_sequence:z.coerce.number()}).optional().parse((await tx`SELECT revision,search_revision,through_sequence FROM assistant.semantic_search_state WHERE workspace_id=${scope.workspace} AND context_id=${head.id}`)[0]);
    if(state?.revision===head.revision&&state.search_revision===head.search_revision&&state.through_sequence>=through)return true;
    const currentIds=z.array(z.object({id:z.string()})).parse(await tx`SELECT id FROM assistant.semantic_search_documents WHERE workspace_id=${scope.workspace} AND context_id=${head.id}`);
    const existingIds=new Set(currentIds.map(document=>document.id));
    const insertions=documents.filter(document=>!existingIds.has(document.id));
    // A concurrent historical sync may have removed rows we saw earlier; re-embed only those.
    const lost=insertions.filter(document=>!cached.has(document.id));
    for(let offset=0;offset<lost.length;offset+=32) {
      const batch=lost.slice(offset,offset+32),vectors=await encodeContext(embed,batch.map(document=>document.text));
      batch.forEach((document,i)=>{const vector=vectors[i];if(!vector)throw new ContextRecallError('invalid_embeddings');cached.set(document.id,SearchDocument.parse({...document,vector}));});
    }
    await Promise.all(insertions.map(document=>{
      const stored=cached.get(document.id);if(!stored)throw new ContextRecallError('invalid_embeddings');
      return tx`INSERT INTO assistant.semantic_search_documents(id,workspace_id,conversation_id,context_id,kind,reference_id,source_sequence,input_hash,start_offset,end_offset,vector)
        VALUES(${stored.id},${scope.workspace},${scope.conversation},${head.id},${stored.kind},${stored.reference_id},${stored.source_sequence},${stored.input_hash},${stored.start_offset},${stored.end_offset},${JSON.stringify(stored.vector)}::vector) ON CONFLICT(id) DO NOTHING`;
    }));
    await tx`DELETE FROM assistant.semantic_search_documents WHERE workspace_id=${scope.workspace} AND context_id=${head.id} AND NOT(id=ANY(${tx.array(ids)}::text[]))`;
    await tx`INSERT INTO assistant.semantic_search_state(workspace_id,conversation_id,context_id,revision,search_revision,through_sequence) VALUES(${scope.workspace},${scope.conversation},${head.id},${head.revision},${head.search_revision},${through})
      ON CONFLICT(workspace_id,context_id) DO UPDATE SET revision=excluded.revision,search_revision=excluded.search_revision,through_sequence=excluded.through_sequence,updated_at=now()`;
    return true;
  });
}
export async function synchronizeContextIndex(sql:Database,embed:ContextEmbed,scope?:SearchScope,through=Number.MAX_SAFE_INTEGER,limit=4) {
  const rows=z.array(Head).parse(await sql`
    SELECT c.id,c.workspace_id,c.conversation_id,c.revision,c.search_revision FROM assistant.semantic_contexts c
    LEFT JOIN assistant.semantic_search_state s ON s.workspace_id=c.workspace_id AND s.context_id=c.id
    WHERE ${scope?sql`c.workspace_id=${scope.workspace}`:sql`true`}
      AND (s.context_id IS NOT NULL OR EXISTS(SELECT 1 FROM assistant.semantic_context_links l WHERE l.workspace_id=c.workspace_id AND l.context_id=c.id AND l.source_sequence<=${through}))
      AND (s.context_id IS NULL OR s.revision<>c.revision OR s.search_revision<>c.search_revision OR s.through_sequence<LEAST(c.source_sequence,${through}))
    ORDER BY c.updated_at,c.id LIMIT ${limit+1}`);
  let synchronized=0;
  for(const head of rows.slice(0,limit))if(await synchronizeContext(sql,embed,head,through))synchronized++;
  return {synchronized,pending:rows.length>limit||synchronized<rows.length};
}
