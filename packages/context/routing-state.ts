import type { SemanticPrepare } from './schema';
export function semanticRoutingState(input:SemanticPrepare) {
  return {
    incoming:{role:input.source.role,created_at:input.source.created_at,text:input.source.content.slice(0,16000),truncated:input.source.truncated||input.source.content.length>16000,files:input.source.attachments.map(file=>file.name)},
    recent_turns:input.neighbors.filter(source=>source.retention_allowed).slice(-6).map(source=>({role:source.role,created_at:source.created_at,text:source.content.slice(0,1000),truncated:source.truncated||source.content.length>1000})),
    contexts:input.candidates.slice(0,24).map(candidate=>{
      const noteRank=new Map(candidate.retrieval.note_ids.map((id,index)=>[id,index]));
      const sourceRank=new Map(candidate.retrieval.source_windows.map((window,index)=>[window.message_id,index]));
      const notes=candidate.notes.filter(note=>note.superseded_by===null).toSorted((a,b)=>(noteRank.get(a.id)??Number.MAX_SAFE_INTEGER)-(noteRank.get(b.id)??Number.MAX_SAFE_INTEGER)||b.source_sequence-a.source_sequence).slice(0,3);
      const sources=candidate.recent_messages.filter(source=>source.retention_allowed).toSorted((a,b)=>(sourceRank.get(a.message_id)??Number.MAX_SAFE_INTEGER)-(sourceRank.get(b.message_id)??Number.MAX_SAFE_INTEGER)||b.sequence-a.sequence).slice(0,1);
      return {context_id:candidate.context_id,title:candidate.title.slice(0,160),scope:candidate.scope.slice(0,300),notes:notes.map(note=>({kind:note.kind,basis:note.basis,text:note.text.slice(0,280),valid_from:note.valid_from,valid_to:note.valid_to})),recent_turns:sources.map(source=>({role:source.role,created_at:source.created_at,text:source.content.slice(0,600),content_offset:source.content_offset,truncated:source.truncated||source.content.length>600}))};
    }),
  };
}
