import { RetentionAssessment } from "./retention";
import { MemoryError, type Source } from "./source";
export { MemoryError, inputHash, type Source } from "./source";
import { z } from "zod";
export const Evidence = z.object({ source_message_id: z.uuid(), quote: z.string().min(1).max(10000) });
export const Claim = z.object({
  kind: z.enum(["assertion", "decision", "commitment"]), context: z.string().min(1).max(200),
  entity: z.string().min(1).max(200), predicate: z.enum(["preference", "constraint", "affiliation", "responsibility", "hypothesis", "claim", "selection", "obligation"]),
  text: z.string().min(1).max(4000), epistemic_status: z.enum(["reported", "inferred", "disputed"]),
  value: z.union([z.string(), z.number(), z.boolean()]), unit: z.string().nullable(),
  valid_from: z.iso.datetime().nullable(), valid_to: z.iso.datetime().nullable(),
  time_precision: z.enum(["unknown", "day", "instant"]), evidence: Evidence,
  supersedes_id: z.uuid().nullable(), correction: z.boolean(),
  due_at: z.iso.datetime().nullable(), due_timezone: z.string().nullable()
});
export const Extraction = z.object({ schema_version: z.literal(1), claims: z.array(Claim).max(100) });
export const ExtractionRequest = z.object({ run_id: z.uuid(), derivation_id: z.uuid(), input_hash: z.string().regex(/^[a-f0-9]{64}$/), source_ids: z.array(z.uuid()).min(1).max(1000), extraction: Extraction, retention: RetentionAssessment.optional() });
export type ExtractionRequest = z.infer<typeof ExtractionRequest>;
export type Claim = z.infer<typeof Claim>;
export function validateClaim(claim: Claim, source: Source): void {
  if (claim.evidence.source_message_id !== source.id || !source.content.includes(claim.evidence.quote)) throw new MemoryError("unsupported_source_span");
  if (source.role !== "user" && claim.epistemic_status !== "inferred") throw new MemoryError("untrusted_source_promotion");
  if (claim.kind === "decision" && source.role !== "user") throw new MemoryError("decision_requires_user_source");
  if (claim.correction && source.role !== "user") throw new MemoryError("correction_requires_user_source");
  if (claim.supersedes_id && !claim.correction) throw new MemoryError("replacement_requires_explicit_correction");
  if (claim.valid_from && claim.valid_to && claim.valid_from >= claim.valid_to) throw new MemoryError("invalid_validity_interval");
  if (claim.time_precision === "unknown" && (claim.valid_from || claim.valid_to)) throw new MemoryError("unknown_time_must_remain_null");
  if (typeof claim.value === "number" && claim.unit === null) throw new MemoryError("numeric_claim_requires_explicit_unit");
  if (claim.due_at && !claim.due_timezone) throw new MemoryError("deadline_requires_timezone");
}
