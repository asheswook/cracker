import { z } from "zod";
import { hashToken, type Principal } from "../../services/control/auth";
import type { Database, Query } from "../../services/control/db";
import { DomainError } from "../protocol";
import { ReorganizeRequest, UndoReorganizationRequest, OrganizationResult } from "./reorganize-schema";
import { SemanticLink } from "./schema";
import { referenceSource, linked, retentionAllowed } from "./store-read";
import { commitLink } from "./store-write";
import { organizationScope, organizationReceipt, recordOrganization, organizationRevisions, type ContextActor } from "./store-organization-access";

export async function undoContextReorganization(sql:Database,actor:ContextActor,input:z.input<typeof UndoReorganizationRequest>) {
 const request=UndoReorganizationRequest.parse(input),payload={kind:'undo',run:actor.run??null,request};
 const completed=await organizationReceipt(sql,actor,request.operation_id,payload);if(completed.result)return completed.result;
 return sql.begin(async tx=>{
  const scope=await organizationScope(tx,actor,request);
  const replay=await organizationReceipt(tx,actor,request.operation_id,payload);if(replay.result)return replay.result;
  const row=(await tx`SELECT actor_role,actor_vm_id,result,resolved_by FROM assistant.semantic_context_organizations WHERE workspace_id=${scope.workspace} AND conversation_id=${scope.conversation} AND operation_id=${request.undo_operation_id} AND kind='apply'`)[0];
  if(!row)throw new DomainError('invalid_undo','Applied organization operation not found',409);
  const original=z.object({actor_role:z.enum(['client','vm']),actor_vm_id:z.uuid().nullable(),result:OrganizationResult,resolved_by:z.uuid().nullable()}).parse(row);
  if(original.resolved_by)throw new DomainError('stale_revision','Operation was already undone',409);
  if(actor.principal.role==='vm'&&(original.actor_role!=='vm'||original.actor_vm_id!==actor.principal.vm_id))throw new DomainError('forbidden','Daemon may only undo its own automatic organization',403);
  const expected=original.result.contexts,current=await organizationRevisions(tx,scope,expected.map(context=>context.context_id));
  if(current.length!==expected.length||current.some(context=>expected.find(prior=>prior.context_id===context.context_id)?.revision!==context.revision))throw new DomainError('stale_revision','Context changed after organization',409);
  const moves=[];
  for(const move of original.result.moves) {
   const before=await linked(tx,scope,move.after.message_id);
   if(!before||JSON.stringify(before)!==JSON.stringify(move.after))throw new DomainError('stale_revision','Membership changed after organization',409);
   const source=await referenceSource(tx,scope,before.message_id);
   if(await hashToken(JSON.stringify(source))!==before.source_sha256)throw new DomainError('stale_source','Linked source changed',409);
   if(!await retentionAllowed(tx,scope,source))throw new DomainError('retention_denied','Source may no longer be retained',409);
   const after=SemanticLink.parse({...move.before,revision:before.revision+1});
   await commitLink(tx,scope,after,{kind:'undo',operation_id:request.operation_id,undo_operation_id:request.undo_operation_id,before});
   await tx`UPDATE assistant.semantic_contexts SET revision=revision+1,updated_at=now() WHERE workspace_id=${scope.workspace} AND id=${before.context_id}`;
   moves.push({before,after});
  }
  const result=OrganizationResult.parse({operation_id:request.operation_id,status:'undone',moves,contexts:await organizationRevisions(tx,scope,expected.map(context=>context.context_id)),created_context_ids:[]});
  await recordOrganization(tx,actor,{scope,kind:'undo',request:payload,hash:replay.hash,result});
  await tx`UPDATE assistant.semantic_context_organizations SET resolved_by=${request.operation_id} WHERE workspace_id=${scope.workspace} AND operation_id=${request.undo_operation_id}`;
  return result;
 });
}
const ProposalPage=z.object({conversation_id:z.uuid(),after_id:z.uuid().optional()}).strict();
export async function contextProposals(sql:Query,principal:Principal,input:z.input<typeof ProposalPage>) {
 if(principal.role!=='client')throw new DomainError('forbidden','Client authentication required',403);
 const request=ProposalPage.parse(input),after=request.after_id??null;
 if(!(await sql`SELECT 1 FROM assistant.conversations WHERE workspace_id=${principal.workspace_id} AND id=${request.conversation_id}`)[0])throw new DomainError('not_found','Conversation not found',404);
 const records=z.array(z.object({operation_id:z.uuid(),request:z.object({request:ReorganizeRequest}),result:OrganizationResult,recorded_at:z.string()})).parse(await sql`SELECT operation_id,request,result,recorded_at FROM assistant.semantic_context_organizations WHERE workspace_id=${principal.workspace_id} AND conversation_id=${request.conversation_id} AND kind='proposal' AND resolved_by IS NULL AND (${after}::uuid IS NULL OR operation_id>${after}::uuid) ORDER BY operation_id LIMIT 33`);
 const page=records.slice(0,32);
 return {proposals:page.map(record=>({...record,request:record.request.request})),next_after_id:records.length>32?(page.at(-1)?.operation_id??null):null};
}
