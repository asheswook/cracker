import { z } from "zod";
import { DomainError } from "../protocol";
import { MemoryError } from "../memory/schema";
import { RetentionContext, RetentionDecision, RetentionSource, validateRetention } from "../memory/retention";
import type { Principal } from "../../services/control/auth";
import type { Database, Query } from "../../services/control/db";
import { SemanticRetentionRequest, SemanticRetentionResult } from "./schema";
import { ownedScope, rawSource, sourceScope, type ContextScope, type RawSource } from "./store-source";

export async function pendingRetention(sql:Query,requestedScope:ContextScope,source:z.infer<typeof RawSource>) {
  const scope=await sourceScope(sql,requestedScope.workspace,source.message_id);
  const rows=await sql`SELECT m.id,m.role,m.content,m.created_at,m.sequence FROM assistant.messages m LEFT JOIN assistant.memory_retention_decisions d ON d.workspace_id=m.workspace_id AND d.source_message_id=m.id LEFT JOIN assistant.semantic_source_retention s ON s.workspace_id=m.workspace_id AND s.source_message_id=m.id WHERE m.workspace_id=${scope.workspace} AND m.conversation_id=${scope.conversation} AND m.task_id IS NOT DISTINCT FROM ${source.task_id}::uuid AND m.role='user' AND m.sequence<=${source.sequence} AND d.source_message_id IS NULL AND s.source_message_id IS NULL ORDER BY m.sequence LIMIT 32`;
  return RetentionContext.parse({sources:z.array(RetentionSource).parse(rows),decisions:[]});
}
export async function allowsRetention(sql:Query,requestedScope:ContextScope,source:z.infer<typeof RawSource>):Promise<boolean> {
  const scope=await sourceScope(sql,requestedScope.workspace,source.message_id);
  if((await sql`SELECT 1 FROM assistant.memory_suppressions WHERE workspace_id=${scope.workspace} AND source_message_id=${source.message_id}`)[0])return false;
  if(source.role==='assistant') {
    const linked=(await sql`SELECT originating_message_id FROM assistant.semantic_context_links WHERE workspace_id=${scope.workspace} AND conversation_id=${scope.conversation} AND message_id=${source.message_id} AND originating_message_id IS NOT NULL`)[0];
    if(linked) {
      const origin=await rawSource(sql,scope,z.object({originating_message_id:z.uuid()}).parse(linked).originating_message_id);
      if(origin.role!=='user'||origin.task_id!==source.task_id||origin.sequence>=source.sequence)return false;
      return allowsRetention(sql,scope,origin);
    }
  }
  if((await pendingRetention(sql,scope,source)).sources.length)return false;
  const current=(await sql`SELECT m.id,COALESCE(d.action,s.action) AS action,EXISTS(SELECT 1 FROM assistant.memory_suppressions x WHERE x.workspace_id=m.workspace_id AND x.source_message_id=m.id) AS suppressed FROM assistant.messages m LEFT JOIN assistant.memory_retention_decisions d ON d.workspace_id=m.workspace_id AND d.source_message_id=m.id LEFT JOIN assistant.semantic_source_retention s ON s.workspace_id=m.workspace_id AND s.source_message_id=m.id WHERE m.workspace_id=${scope.workspace} AND m.conversation_id=${scope.conversation} AND m.task_id IS NOT DISTINCT FROM ${source.task_id}::uuid AND m.role='user' AND m.sequence<=${source.sequence} ORDER BY m.sequence DESC LIMIT 1`)[0];
  if(!current)return true;
  const turn=z.object({id:z.uuid(),action:RetentionDecision.shape.action,suppressed:z.boolean()}).parse(current);
  if(turn.suppressed||turn.action==='deny_turn'||turn.action==='deny_task')return false;
  if(turn.action==='allow')return true;
  const persistent=(await sql`SELECT COALESCE(d.action,s.action) AS action FROM assistant.messages m LEFT JOIN assistant.memory_retention_decisions d ON d.workspace_id=m.workspace_id AND d.source_message_id=m.id LEFT JOIN assistant.semantic_source_retention s ON s.workspace_id=m.workspace_id AND s.source_message_id=m.id WHERE m.workspace_id=${scope.workspace} AND m.conversation_id=${scope.conversation} AND m.task_id IS NOT DISTINCT FROM ${source.task_id}::uuid AND m.sequence<=${source.sequence} AND COALESCE(d.action,s.action) IN ('allow','deny_task') ORDER BY m.sequence DESC LIMIT 1`)[0];
  return !persistent||z.object({action:RetentionDecision.shape.action}).parse(persistent).action==='allow';
}
export async function assessSemanticRetention(sql:Database,principal:Principal,run:string,input:z.input<typeof SemanticRetentionRequest>) {
  const request=SemanticRetentionRequest.parse(input);
  return sql.begin(async tx=>{
    const owned=await ownedScope(tx,principal,run,true,request.mode),scope={workspace:principal.workspace_id,conversation:owned.conversation_id};
    await tx`SELECT id FROM assistant.conversations WHERE workspace_id=${scope.workspace} AND id=${scope.conversation} FOR UPDATE`;
    const source=await rawSource(tx,scope,request.message_id);
    if(request.mode==='live'&&source.task_id!==owned.task_id)throw new DomainError('invalid_source','Live retention requires this run task',409);
    const ids=request.assessment.decisions.map(decision=>decision.source_message_id);
    const recorded=z.array(RetentionSource.extend({action:RetentionDecision.shape.action,quote:RetentionDecision.shape.quote})).parse(await tx`SELECT m.id,m.role,m.content,m.created_at,m.sequence,COALESCE(d.action,s.action) AS action,COALESCE(d.quote,s.quote) AS quote FROM assistant.messages m LEFT JOIN assistant.memory_retention_decisions d ON d.workspace_id=m.workspace_id AND d.source_message_id=m.id LEFT JOIN assistant.semantic_source_retention s ON s.workspace_id=m.workspace_id AND s.source_message_id=m.id WHERE m.workspace_id=${scope.workspace} AND m.conversation_id=${scope.conversation} AND m.task_id IS NOT DISTINCT FROM ${source.task_id}::uuid AND m.role='user' AND m.sequence<=${source.sequence} AND m.id=ANY(${tx.array(ids)}::uuid[]) AND COALESCE(d.action,s.action) IS NOT NULL ORDER BY m.sequence`);
    const context=recorded.length>0&&recorded.length===ids.length
      ? RetentionContext.parse({sources:recorded,decisions:recorded.map(item=>({source_message_id:item.id,action:item.action,quote:item.quote}))})
      : await pendingRetention(tx,scope,source);
    try{await validateRetention(context,request.assessment)}catch(error){if(error instanceof MemoryError)throw new DomainError(error.code,error.message,409);throw error}
    for(const decision of request.assessment.decisions) {
      if(source.task_id)await tx`INSERT INTO assistant.memory_retention_decisions(workspace_id,task_id,source_message_id,action,quote) VALUES(${scope.workspace},${source.task_id},${decision.source_message_id},${decision.action},${decision.quote}) ON CONFLICT DO NOTHING`;
      else await tx`INSERT INTO assistant.semantic_source_retention(workspace_id,conversation_id,source_message_id,action,quote) VALUES(${scope.workspace},${scope.conversation},${decision.source_message_id},${decision.action},${decision.quote}) ON CONFLICT DO NOTHING`;
      const saved=RetentionDecision.parse((await tx`SELECT source_message_id,action,quote FROM assistant.memory_retention_decisions WHERE workspace_id=${scope.workspace} AND source_message_id=${decision.source_message_id} UNION ALL SELECT source_message_id,action,quote FROM assistant.semantic_source_retention WHERE workspace_id=${scope.workspace} AND source_message_id=${decision.source_message_id}`)[0]);
      if(saved.action!==decision.action||saved.quote!==decision.quote)throw new DomainError('retention_decision_conflict','A concurrent retention decision differs',409);
    }
    return SemanticRetentionResult.parse({retention_allowed:await allowsRetention(tx,scope,source),retention_context:await pendingRetention(tx,scope,source)});
  });
}
