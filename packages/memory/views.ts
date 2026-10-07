import { z } from "zod";
import type { Query } from "../../services/control/db.ts";
import { DomainError } from "../protocol/index.ts";

export const MemoryView = z.object({
  id:z.uuid(),text:z.string(),created_at:z.string(),source_message_id:z.uuid().nullable(),
  provenance:z.enum(["extracted","user_note","user_correction"]),
  epistemic_status:z.enum(["reported","inferred","disputed"]),
  conversation_id:z.uuid().nullable(),context:z.string().nullable(),predicate:z.string().nullable(),
  source_excerpt:z.string().nullable(),source_role:z.enum(["user","assistant","system"]).nullable(),source_created_at:z.string().nullable(),
  valid_from:z.string().nullable(),valid_to:z.string().nullable(),known_from:z.string(),
  root_memory_id:z.uuid(),supersedes_id:z.uuid().nullable(),
});
export async function memoryViews(sql:Query, workspace:string, options:{readonly id?:string;readonly query?:string}={}){
  return z.array(MemoryView).parse(await sql`
    SELECT m.id,m.text,m.created_at,m.source_message_id,
      CASE WHEN o.id IS NOT NULL THEN 'user_correction' WHEN a.id IS NOT NULL THEN 'extracted' ELSE 'user_note' END AS provenance,
      CASE WHEN o.id IS NOT NULL OR a.id IS NULL THEN 'reported' ELSE a.epistemic_status END AS epistemic_status,
      CASE WHEN o.id IS NOT NULL THEN o.conversation_id ELSE COALESCE(c.conversation_id,s.conversation_id) END AS conversation_id,
      c.scope_key AS context,a.predicate,COALESCE(a.source_span,left(s.content,1000)) AS source_excerpt,
      s.role AS source_role,s.created_at AS source_created_at,
      CASE WHEN o.id IS NULL THEN a.valid_from END AS valid_from,CASE WHEN o.id IS NULL THEN a.valid_to END AS valid_to,
      COALESCE(o.created_at,a.known_from,m.created_at) AS known_from,
      COALESCE(o.root_memory_id,m.id) AS root_memory_id,o.supersedes_id
    FROM assistant.memories m
    LEFT JOIN assistant.memory_corrections o ON o.workspace_id=m.workspace_id AND o.id=m.id
    LEFT JOIN assistant.memory_assertions a ON a.id=COALESCE(o.root_memory_id,m.id)
    LEFT JOIN assistant.memory_contexts c ON c.id=a.context_id
    LEFT JOIN assistant.messages s ON s.workspace_id=m.workspace_id AND s.id=m.source_message_id
    WHERE m.workspace_id=${workspace} AND (${options.id??null}::uuid IS NULL OR m.id=${options.id??null})
      AND (${options.id??null}::uuid IS NOT NULL OR (
        m.deleted_at IS NULL
        AND NOT EXISTS(SELECT 1 FROM assistant.memory_corrections n WHERE n.workspace_id=m.workspace_id AND n.supersedes_id=m.id)
        AND ((o.id IS NOT NULL AND o.known_to IS NULL) OR (o.id IS NULL AND (a.id IS NULL OR (a.known_to IS NULL AND (a.valid_from IS NULL OR a.valid_from<=now()) AND (a.valid_to IS NULL OR a.valid_to>now())))))
        AND NOT EXISTS(SELECT 1 FROM assistant.memory_suppressions x WHERE x.workspace_id=m.workspace_id AND x.source_message_id=m.source_message_id)
      )) AND m.text ILIKE ${`%${options.query??""}%`}
    ORDER BY m.created_at DESC,m.id LIMIT 100`);
}
export async function memoryHistory(sql:Query,workspace:string,id:string){
  const memory=(await memoryViews(sql,workspace,{id}))[0];
  if(!memory)throw new DomainError("not_found","Memory not found",404);
  const ids=await memoryVersionIds(sql,workspace,id);
  return z.array(z.object({id:z.uuid(),text:z.string(),created_at:z.string(),provenance:z.enum(["original","user_correction","conversation_correction"]),deleted:z.boolean(),current:z.boolean()})).parse(await sql`
    SELECT m.id,m.text,m.created_at,CASE WHEN o.id IS NOT NULL THEN 'user_correction' WHEN a.supersedes_id IS NOT NULL THEN 'conversation_correction' ELSE 'original' END AS provenance,
      m.deleted_at IS NOT NULL AS deleted,
      m.deleted_at IS NULL AND a.known_to IS NULL AND o.known_to IS NULL AND NOT EXISTS(SELECT 1 FROM assistant.memory_corrections n WHERE n.workspace_id=m.workspace_id AND n.supersedes_id=m.id) AS current
    FROM assistant.memories m LEFT JOIN assistant.memory_corrections o ON o.workspace_id=m.workspace_id AND o.id=m.id
    LEFT JOIN assistant.memory_assertions a ON a.workspace_id=m.workspace_id AND a.id=m.id
    WHERE m.workspace_id=${workspace} AND m.id IN ${sql(ids)} ORDER BY m.created_at,m.id`);
}
export async function memoryVersionIds(sql:Query,workspace:string,id:string):Promise<string[]>{
  const rows=z.array(z.object({id:z.uuid()})).parse(await sql`
    WITH RECURSIVE edges AS (
      SELECT m.id,COALESCE(o.supersedes_id,a.supersedes_id) AS parent FROM assistant.memories m
      LEFT JOIN assistant.memory_corrections o ON o.workspace_id=m.workspace_id AND o.id=m.id
      LEFT JOIN assistant.memory_assertions a ON a.workspace_id=m.workspace_id AND a.id=m.id WHERE m.workspace_id=${workspace}
    ), ancestors AS (
      SELECT * FROM edges WHERE id=${id} UNION ALL SELECT e.* FROM edges e JOIN ancestors p ON p.parent=e.id
    ), versions AS (
      SELECT * FROM edges WHERE id IN (SELECT id FROM ancestors WHERE parent IS NULL)
      UNION ALL SELECT e.* FROM edges e JOIN versions p ON e.parent=p.id
    ) SELECT id FROM versions`);
  return rows.map(row=>row.id);
}
