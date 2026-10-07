import { z } from "zod";
import { hashToken, type Principal } from "../../services/control/auth";
import type { Query, Transaction } from "../../services/control/db";
import { DomainError } from "../protocol";
import { OrganizationResult } from "./reorganize-schema";
import { ownedScope, type ContextScope } from "./store-source";

export type ContextActor=Readonly<{principal:Principal;run?:string}>;
export async function organizationScope(tx:Transaction,actor:ContextActor,input:Readonly<{conversation_id:string;mode:'live'|'backfill'}>) {
 const {principal}=actor;
 if(principal.role==='vm') {
  if(!actor.run)throw new DomainError('forbidden','A daemon run is required',403);
  const owned=await ownedScope(tx,principal,actor.run,true,input.mode);
  if(owned.conversation_id!==input.conversation_id)throw new DomainError('invalid_context','Run conversation differs',409);
 } else if(actor.run)throw new DomainError('forbidden','Daemon routes require VM credentials',403);
 const scope={workspace:principal.workspace_id,conversation:input.conversation_id};
 if(!(await tx`SELECT 1 FROM assistant.conversations WHERE workspace_id=${scope.workspace} AND id=${scope.conversation} FOR UPDATE`)[0])throw new DomainError('not_found','Conversation not found',404);
 return scope;
}
export async function organizationReceipt(sql:Query,actor:ContextActor,operation:string,request:unknown) {
 const hash=await hashToken(JSON.stringify(request));
 const row=(await sql`SELECT actor_role,actor_vm_id,request_hash,result FROM assistant.semantic_context_organizations WHERE workspace_id=${actor.principal.workspace_id} AND operation_id=${operation}`)[0];
 if(!row)return {hash,result:null};
 const saved=z.object({actor_role:z.enum(['client','vm']),actor_vm_id:z.uuid().nullable(),request_hash:z.string(),result:OrganizationResult}).parse(row);
 if(saved.actor_role!==actor.principal.role||saved.actor_vm_id!==actor.principal.vm_id||saved.request_hash!==hash)throw new DomainError('idempotency_conflict','Organization operation payload changed',409);
 return {hash,result:saved.result};
}
export async function recordOrganization(sql:Query,actor:ContextActor,input:Readonly<{scope:ContextScope;kind:'proposal'|'apply'|'undo';request:unknown;hash:string;result:z.infer<typeof OrganizationResult>}>) {
 await sql`INSERT INTO assistant.semantic_context_organizations(workspace_id,conversation_id,operation_id,actor_role,actor_vm_id,kind,request_hash,request,result) VALUES(${input.scope.workspace},${input.scope.conversation},${input.result.operation_id},${actor.principal.role},${actor.principal.vm_id},${input.kind},${input.hash},${JSON.stringify(input.request)}::text::jsonb,${JSON.stringify(input.result)}::text::jsonb)`;
}
export async function organizationRevisions(sql:Query,scope:ContextScope,ids:readonly string[]) {
 return z.array(z.object({context_id:z.uuid(),revision:z.number().int()})).parse(await sql`SELECT id AS context_id,revision FROM assistant.semantic_contexts WHERE workspace_id=${scope.workspace} AND id=ANY(${sql.array([...ids])}::uuid[]) ORDER BY id FOR UPDATE`);
}
