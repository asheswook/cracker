import { z } from 'zod';
import { ClaimDraft, ClaimUpdate } from './claims-extraction';
const hash=z.string().regex(/^[a-f0-9]{64}$/);
export const ClaimSpan=z.object({message_id:z.uuid(),source_sha256:hash,start:z.number().int().nonnegative(),end:z.number().int().positive(),quote:z.string(),requested_quote:z.string().nullable().optional(),resolution:z.literal('normalized').nullable().optional()});
export const Claim=z.object({id:z.uuid(),exchange_id:z.uuid(),context_id:z.uuid().nullable(),origin_message_id:z.uuid(),origin_source_sha256:hash,origin_sequence:z.coerce.number(),text:z.string(),subjects:z.array(z.string()),kind:ClaimDraft.shape.kind,basis:ClaimDraft.shape.basis,epistemic:z.literal('assistant_report'),current_status:z.enum(['active','challenged','corrected','retracted','reaffirmed']),revision:z.coerce.number(),evidence:ClaimSpan});
// Delivery needs origin coordinates/status, never claim text or basis evidence.
export const DeliveryClaim=Claim.pick({current_status:true,evidence:true});
export const ClaimsReadRequest=z.object({message_id:z.uuid(),limit:z.number().int().min(1).max(256).default(128),metadata_only:z.boolean().default(false),prepare:z.boolean().default(false),delivery_source_ids:z.array(z.uuid()).max(256).optional()});
export const ClaimsRequest=z.object({message_id:z.uuid(),source_sha256:hash,extractor_version:z.string().min(1),provider_model:z.string().min(1),prompt_sha256:hash,schema_version:z.string().min(1),request_sha256:hash,claims:z.array(z.unknown()).max(128),updates:z.array(z.unknown()).max(128).default([]),quarantine_reason:z.enum(['claim_invalid_envelope','claim_missing_exchange']).optional()});
export const ClaimTransition=ClaimUpdate.extend({expected_revision:z.number().int().positive()});
export const ClaimCreation=ClaimDraft.extend({ordinal:z.number().int().nonnegative()});
