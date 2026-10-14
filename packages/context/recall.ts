import { z } from 'zod';
import type { Database } from '../../services/control/db';
import { contextSnapshot } from './store-read';
import type { SemanticRetriever } from './schema';
import { contextDocumentHash, synchronizeContextIndex } from './recall-index';
import { ContextRecallError, encodeContext, SearchDocument, type ContextEmbed } from './recall-types';
const RankedDocument=SearchDocument.omit({vector:true}).extend({score:z.coerce.number().finite()});
export { CONTEXT_EMBEDDING_MODEL, contextCosine, ContextRecallError, type ContextEmbed } from './recall-types';

export function createSemanticRetriever(sql:Database,embed:ContextEmbed):SemanticRetriever {
  return async(input,scope)=>{
    if(input.linked||!input.source.retention_allowed||input.retention_context.sources.length)return [];
    const synchronization=await synchronizeContextIndex(sql,embed,scope,input.source.sequence);
    if(synchronization.pending)throw new ContextRecallError('index_pending');
    const text=[input.source.content.slice(0,12000),...input.source.attachments.map(file=>file.name)].join('\n');
    if(!text.trim())return [];
    const [vector]=await encodeContext(embed,[text]);if(!vector)throw new ContextRecallError('invalid_embeddings');
    const query=JSON.stringify(vector),columns=sql.unsafe('id,context_id,kind,reference_id,source_sequence,input_hash,start_offset,end_offset');
    const matching=await sql.begin(async tx=>{
      // Filters run after ANN scanning. pgvector 0.8 iterates to fill the 64-hit budget;
      // relaxed ordering is safe because we re-rank below. LOCAL avoids pooled-session leaks.
      await tx`SET LOCAL hnsw.iterative_scan = relaxed_order`;
      await tx`SET LOCAL hnsw.ef_search = 100`;
      return z.array(RankedDocument).parse(await tx`SELECT ${columns},1-(vector <=> ${query}::vector) AS score FROM assistant.semantic_search_documents WHERE workspace_id=${scope.workspace} AND source_sequence<=${input.source.sequence} ORDER BY vector <=> ${query}::vector LIMIT 64`);
    });
    // Similarity is computed in PostgreSQL; shipping 1024-float vectors as JSON cost seconds per lookup.
    const recent=z.array(RankedDocument).parse(await sql`SELECT ${columns},1-(vector <=> ${query}::vector) AS score FROM assistant.semantic_search_documents WHERE workspace_id=${scope.workspace} AND source_sequence<=${input.source.sequence} AND updated_at>now()-interval '10 minutes' ORDER BY updated_at DESC,id LIMIT 128`);
    const unique=[...new Map([...matching,...recent].map(({score,...document})=>[document.id,{document,score}])).values()];
    const ranked=unique.toSorted((a,b)=>b.score-a.score||a.document.id.localeCompare(b.document.id));
    const groups=new Map<string,typeof ranked>();
    for(const item of ranked){const items=groups.get(item.document.context_id)??[];items.push(item);groups.set(item.document.context_id,items);}
    const result=[];
    const orderedGroups=[...groups];
    for(let offset=0;offset<orderedGroups.length&&result.length<24;offset+=4) {
      const batch=await Promise.allSettled(orderedGroups.slice(offset,offset+4).map(async([contextId,items])=>{
        const noteIds=items.filter(item=>item.document.kind==='note').slice(0,16).map(item=>item.document.reference_id);
        const sourceItems=items.filter(item=>item.document.kind==='source');
        const sources=sourceItems.filter((item,i)=>sourceItems.findIndex(other=>other.document.reference_id===item.document.reference_id)===i).slice(0,8).map(item=>item.document);
        const windows=sources.map(document=>({message_id:document.reference_id,start:document.start_offset,end:document.end_offset}));
        const context=await contextSnapshot(sql,scope,contextId,input.source.sequence,noteIds,sources.map(document=>document.reference_id),windows);
        const valid:typeof ranked=[];
        for(const item of items) {
          const document=item.document;
          const source=context.recent_messages.find(source=>source.message_id===document.reference_id&&source.content_offset===document.start_offset);
          const current=document.kind==='note'?context.notes.find(note=>note.id===document.reference_id)?.text:
            source?(source.content||source.attachments.map(file=>file.name).join('\n')):undefined;
          if(current!==undefined&&await contextDocumentHash(current)===document.input_hash)valid.push(item);
        }
        if(!valid.length)return null;
        return {context_id:contextId,note_ids:valid.filter(item=>item.document.kind==='note').slice(0,16).map(item=>item.document.reference_id),source_windows:windows.filter(window=>valid.some(item=>item.document.reference_id===window.message_id&&item.document.start_offset===window.start)),score:Math.max(...valid.map(item=>item.score))};
      }));
      // Consume in rank order: failures beyond the serial cutoff are speculative.
      for(const settled of batch) {
        if(result.length===24)break;
        switch(settled.status) {
          case 'rejected': throw settled.reason;
          case 'fulfilled': if(settled.value)result.push(settled.value);break;
          default: throw settled satisfies never;
        }
      }
    }
    return result.toSorted((a,b)=>b.score-a.score).slice(0,12).map(({score:_score,...item})=>item);
  };
}
