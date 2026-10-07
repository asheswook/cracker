import { z } from "zod";
import { DomainError } from "../protocol";
import type { Query, Transaction } from "../../services/control/db";
import { MemoryError } from "./schema";
import { RetentionContext, RetentionDecision, RetentionSource, type RetentionAssessment, validateRetention } from "./retention";
type Scope = { readonly workspace: string; readonly task: string };
export async function retentionContext(sql: Query, scope: Scope): Promise<RetentionContext> {
  const sources = z.array(RetentionSource).parse(await sql`SELECT id,role,content,created_at,sequence FROM assistant.messages WHERE workspace_id=${scope.workspace} AND task_id=${scope.task} AND role='user' ORDER BY sequence`);
  const decisions = z.array(RetentionDecision).parse(await sql`SELECT source_message_id,action,quote FROM assistant.memory_retention_decisions WHERE workspace_id=${scope.workspace} AND task_id=${scope.task}`);
  return { sources, decisions };
}
export async function persistRetention(tx: Transaction, scope: Scope, assessment: RetentionAssessment | undefined): Promise<RetentionContext> {
  if (!assessment) throw new DomainError("retention_assessment_required", "Memory retention assessment required; update the daemon", 409);
  const context = await retentionContext(tx, scope);
  try { await validateRetention(context, assessment); }
  catch (error) { if (error instanceof MemoryError) throw new DomainError(error.code, error.message, 409); throw error; }
  for (const decision of assessment.decisions) {
    await tx`INSERT INTO assistant.memory_retention_decisions(workspace_id,task_id,source_message_id,action,quote) VALUES(${scope.workspace},${scope.task},${decision.source_message_id},${decision.action},${decision.quote}) ON CONFLICT DO NOTHING`;
  }
  return { sources: context.sources, decisions: assessment.decisions };
}
