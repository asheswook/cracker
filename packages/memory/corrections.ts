import { z } from "zod";
import { DomainError } from "../protocol/index.ts";
import type { Database, Transaction } from "../../services/control/db.ts";
import type { Principal } from "../../services/control/auth.ts";
import { recordEvent } from "../../services/control/repository/common.ts";
import { memoryVersionIds, memoryViews } from "./views.ts";

export const Correction = z.object({text:z.string().trim().min(1).max(20000),client_correction_id:z.uuid()}).strict();
export async function correctMemory(sql:Database,principal:Principal,request:{readonly target:string;readonly body:z.infer<typeof Correction>}){
  const {target,body}=request;
  if(principal.role!=="client"||!principal.credential_hash)throw new DomainError("forbidden","Client identity required",403);
  const actor=principal.credential_hash,workspace=principal.workspace_id;
  return sql.begin(async tx=>{
    await tx`SELECT id FROM assistant.workspaces WHERE id=${workspace} FOR UPDATE`;
    const previous=await tx`SELECT m.text,o.supersedes_id FROM assistant.memory_corrections o JOIN assistant.memories m ON m.id=o.id WHERE o.workspace_id=${workspace} AND o.id=${body.client_correction_id}`;
    if(previous[0]){
      const receipt=z.object({text:z.string(),supersedes_id:z.uuid()}).parse(previous[0]);
      if(receipt.text!==body.text||receipt.supersedes_id!==target)throw new DomainError("idempotency_conflict","Correction ID reused",409);
      return (await memoryViews(tx,workspace,{id:body.client_correction_id}))[0];
    }
    const memory=(await memoryViews(tx,workspace,{id:target}))[0];
    if(!memory)throw new DomainError("not_found","Memory not found",404);
    const active=await tx`SELECT m.id FROM assistant.memories m LEFT JOIN assistant.memory_assertions a ON a.id=m.id LEFT JOIN assistant.memory_corrections o ON o.id=m.id WHERE m.workspace_id=${workspace} AND m.id=${target} AND m.deleted_at IS NULL AND a.known_to IS NULL AND o.known_to IS NULL AND NOT EXISTS(SELECT 1 FROM assistant.memory_corrections n WHERE n.workspace_id=m.workspace_id AND n.supersedes_id=m.id) AND NOT EXISTS(SELECT 1 FROM assistant.memory_suppressions s WHERE s.workspace_id=m.workspace_id AND s.source_message_id=m.source_message_id)`;
    if(!active[0])throw new DomainError("memory_version_changed","Memory is no longer current",409);
    await tx`INSERT INTO assistant.memories(id,workspace_id,text,source_message_id) VALUES(${body.client_correction_id},${workspace},${body.text},${memory.source_message_id})`;
    await tx`INSERT INTO assistant.memory_corrections(id,workspace_id,root_memory_id,supersedes_id,conversation_id,actor_credential_hash,typed_value) VALUES(${body.client_correction_id},${workspace},${memory.root_memory_id},${target},${memory.conversation_id},${actor},${JSON.stringify({value:body.text,unit:null})}::text::jsonb)`;
    await tx`UPDATE assistant.memory_assertions SET known_to=now() WHERE workspace_id=${workspace} AND id=${target} AND known_to IS NULL`;
    await tx`UPDATE assistant.memory_corrections SET known_to=now() WHERE workspace_id=${workspace} AND id=${target} AND known_to IS NULL`;
    await recordEvent(tx,{workspace,kind:"memory.corrected",payload:JSON.stringify({id:body.client_correction_id,supersedes_id:target,root_memory_id:memory.root_memory_id})});
    return (await memoryViews(tx,workspace,{id:body.client_correction_id}))[0];
  });
}
export async function deleteCorrection(tx:Transaction,workspace:string,id:string):Promise<boolean>{
  const rows=await tx`SELECT root_memory_id FROM assistant.memory_corrections WHERE workspace_id=${workspace} AND id=${id}`;
  if(!rows[0])return false;
  const ids=await memoryVersionIds(tx,workspace,id);
  await tx`UPDATE assistant.memories SET deleted_at=COALESCE(deleted_at,now()) WHERE workspace_id=${workspace} AND id IN ${tx(ids)}`;
  return true;
}
