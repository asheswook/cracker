import { z } from "zod";
import type { Query } from "../../services/control/db";
import { SemanticNote } from "./schema";
import type { ContextScope } from "./store-source";
import { sourceBatch, requireSource } from "./source-batch";

const NotePage = z.object({context_id:z.uuid(),through:z.number().int().nonnegative().default(Number.MAX_SAFE_INTEGER),after_id:z.uuid().optional(),limit:z.number().int().min(1).max(64).default(32)}).strict();

const ScopedNote=SemanticNote.extend({context_id:z.uuid()});

async function retainedNotes(sql:Query,scope:ContextScope,notes:readonly z.infer<typeof ScopedNote>[]) {
  const visible=[];
  const records=await sourceBatch(sql,scope,notes.flatMap(note=>[note.source_message_id,...note.evidence.map(item=>item.message_id)]));
  for(const note of notes) {
    const record=requireSource(records,note.source_message_id);
    if(record.sha256!==note.source_sha256||!record.retentionAllowed)continue;
    let valid=true;
    for(const id of new Set([note.source_message_id,...note.evidence.map(item=>item.message_id)])) {
      const evidence=requireSource(records,id),original=evidence.raw;
      if(evidence.link?.context_id!==note.context_id||!evidence.retentionAllowed)valid=false;
      if(note.evidence.some(item=>item.message_id===id&&!(original.content.includes(item.quote)||original.attachments.some(file=>file.name===item.quote))))valid=false;
    }
    if(valid)visible.push(note);
  }
  return visible;
}
export async function retainedContextNotes(sql:Query,scope:ContextScope,input:z.input<typeof NotePage>) {
  const page=NotePage.parse(input),after=page.after_id??null;
  const rows=z.array(ScopedNote).parse(await sql`SELECT n.id,n.context_id,n.context_revision,n.kind,n.text,n.evidence,n.basis,n.source_message_id,n.source_sha256,n.source_sequence,n.supersedes,n.superseded_by,n.valid_from,n.valid_to,n.recorded_at FROM assistant.semantic_context_notes n LEFT JOIN assistant.semantic_context_notes replacement ON replacement.id=n.superseded_by WHERE n.workspace_id=${scope.workspace} AND n.context_id=${page.context_id} AND n.source_sequence<=${page.through} AND (n.superseded_by IS NULL OR replacement.source_sequence>${page.through}) AND (${after}::uuid IS NULL OR n.id>${after}::uuid) ORDER BY n.id LIMIT ${page.limit+1}`);
  const selected=rows.slice(0,page.limit);
  return {notes:(await retainedNotes(sql,scope,selected)).map(({context_id,...note})=>({...note,superseded_by:null})),next_after_id:rows.length>page.limit?(selected.at(-1)?.id??null):null};
}

export async function snapshotContextNotes(sql:Query,scope:ContextScope,input:Readonly<{context_id:string;through:number;note_ids:readonly string[]}>) {
  const rows=z.array(ScopedNote).parse(await sql`WITH chosen AS (
    (SELECT n.* FROM assistant.semantic_context_notes n LEFT JOIN assistant.semantic_context_notes replacement ON replacement.id=n.superseded_by WHERE n.workspace_id=${scope.workspace} AND n.context_id=${input.context_id} AND n.source_sequence<=${input.through} AND (n.superseded_by IS NULL OR replacement.source_sequence>${input.through}) ORDER BY n.context_revision DESC,n.id LIMIT 16)
    UNION
    (SELECT n.* FROM assistant.semantic_context_notes n LEFT JOIN assistant.semantic_context_notes replacement ON replacement.id=n.superseded_by WHERE n.workspace_id=${scope.workspace} AND n.context_id=${input.context_id} AND n.source_sequence<=${input.through} AND (n.superseded_by IS NULL OR replacement.source_sequence>${input.through}) AND n.id=ANY(${sql.array([...input.note_ids])}::uuid[]))
  ) SELECT id,context_id,context_revision,kind,text,evidence,basis,source_message_id,source_sha256,source_sequence,supersedes,superseded_by,valid_from,valid_to,recorded_at FROM chosen ORDER BY context_revision DESC,id`);
  return (await retainedNotes(sql,scope,rows)).map(({context_id,...note})=>({...note,superseded_by:null}));
}
