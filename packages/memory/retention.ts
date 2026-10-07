import { z } from "zod";
import { inputHash, MemoryError } from "./source";
export const RetentionDecision = z.object({
  source_message_id: z.uuid(),
  action: z.enum(["inherit", "allow", "deny_turn", "deny_task"]),
  quote: z.string().min(1).max(10000).nullable(),
});
export const RetentionSource = z.object({ id: z.uuid(), role: z.literal("user"), content: z.string(), created_at: z.string(), sequence: z.coerce.number().int() });
export const RetentionContext = z.object({ sources: z.array(RetentionSource), decisions: z.array(RetentionDecision) });
export const RetentionAssessment = z.object({ input_hash: z.string().regex(/^[a-f0-9]{64}$/), decisions: z.array(RetentionDecision) });
export type RetentionContext = z.infer<typeof RetentionContext>;
export type RetentionAssessment = z.infer<typeof RetentionAssessment>;
export async function validateRetention(context: RetentionContext, assessment: RetentionAssessment): Promise<void> {
  if (assessment.input_hash !== await inputHash(context.sources)) throw new MemoryError("retention_snapshot_stale");
  if (assessment.decisions.length !== context.sources.length || new Set(assessment.decisions.map(d => d.source_message_id)).size !== context.sources.length) throw new MemoryError("retention_decisions_incomplete");
  for (const source of context.sources) {
    const decision = assessment.decisions.find(d => d.source_message_id === source.id);
    if (!decision) throw new MemoryError("retention_decisions_incomplete");
    if (decision.action === "inherit" ? decision.quote !== null : decision.quote === null || !source.content.includes(decision.quote)) throw new MemoryError("retention_unsupported_directive");
    const recorded = context.decisions.find(d => d.source_message_id === source.id);
    if (recorded && (recorded.action !== decision.action || recorded.quote !== decision.quote)) throw new MemoryError("retention_decision_conflict");
  }
}
export function retentionAllows(context: RetentionContext, decisions: readonly z.infer<typeof RetentionDecision>[], sequence: number): boolean {
  let taskAllowed = true, turnAllowed = true;
  for (const source of context.sources) {
    if (source.sequence > sequence) break;
    const decision = decisions.find(d => d.source_message_id === source.id);
    if (!decision) throw new MemoryError("retention_decisions_incomplete");
    switch (decision.action) {
      case "inherit": turnAllowed = taskAllowed; break;
      case "allow": taskAllowed = true; turnAllowed = true; break;
      case "deny_turn": turnAllowed = false; break;
      case "deny_task": taskAllowed = false; turnAllowed = false; break;
      default: assertNever(decision.action);
    }
  }
  return turnAllowed;
}
function assertNever(value: never): never { throw new MemoryError(`unknown_retention_action:${String(value)}`); }
