import { z } from "zod";

export const ExchangeRequest=z.object({user_message_id:z.uuid()}).strict();
export const MemberRequest=z.object({message_id:z.uuid(),response_to_message_id:z.uuid(),kind:z.enum(['answer','progress','unknown']),method:z.enum(['response_to','heuristic','legacy']),method_version:z.string().min(1).max(80).default('1'),applied_user_ids:z.array(z.uuid()).max(256).default([]),run:z.uuid().optional()}).strict();
export const StructureEvidence=z.object({exchange_id:z.uuid(),message_id:z.uuid(),source_sha256:z.string().regex(/^[a-f0-9]{64}$/),start:z.number().int().nonnegative(),end:z.number().int().positive(),quote:z.string().min(1).max(100000)}).strict();
export const SubjectAction=z.enum(['same_subject','new_subject_branch','return_to_region','new_root']);
const EdgeFields=z.object({
 child_exchange_id:z.uuid(),role:z.enum(['primary','reference']).default('primary'),
 continuation_exchange_id:z.uuid().nullable().default(null),
 state:z.enum(['root','unresolved','linked']),target_exchange_id:z.uuid().nullable().default(null),
 relation:z.enum(['follow_up','challenge','apply_example','correction','instruction','new_topic']).nullable().default(null),is_return:z.boolean().default(false),
 subject_action:SubjectAction.nullable().default(null),proposed_subject:z.string().min(1).max(80).nullable().default(null),subject_confidence:z.coerce.number().min(0).max(1).nullable().default(null),
 branch_from:StructureEvidence.extend({confidence:z.number().min(0).max(1)}).nullable().default(null),return_region_ref:z.uuid().nullable().default(null),return_evidence:StructureEvidence.nullable().default(null),reference_evidence:StructureEvidence.nullable().default(null),
 target_message_id:z.uuid().nullable().default(null),target_source_sha256:z.string().regex(/^[a-f0-9]{64}$/).nullable().default(null),
 target_start:z.number().int().nonnegative().nullable().default(null),target_end:z.number().int().positive().nullable().default(null),
 anchor_confidence:z.coerce.number().min(0).max(1).nullable().default(null),relation_confidence:z.coerce.number().min(0).max(1).nullable().default(null),
 status:z.enum(['provisional','confirmed','rejected']).default('provisional'),method:z.enum(['explicit','heuristic','llm','user']),model:z.string().min(1).max(160).nullable().default(null),policy_version:z.string().min(1).max(80).default('1'),
});
export const EdgeRequest=EdgeFields.extend({operation_id:z.uuid(),expected_revision:z.number().int().nonnegative(),quote:z.string().min(1).max(100000).nullable().default(null)}).strict();
export const Edge=EdgeFields.extend({revision:z.number().int().positive(),needs_revalidation:z.boolean(),updated_at:z.string()});
export const UndoEdgeRequest=z.object({operation_id:z.uuid(),child_exchange_id:z.uuid(),role:z.enum(['primary','reference']).default('primary'),target_exchange_id:z.uuid().nullable().default(null),expected_revision:z.number().int().positive(),to_revision:z.number().int().positive()}).strict();
export const StructureReadRequest=z.object({through_sequence:z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER),limit:z.number().int().min(1).max(64).default(24),ancestors_of:z.uuid().optional(),max_hops:z.number().int().min(1).max(32).default(12),stop_at_provisional:z.boolean().default(true)}).strict();
export const Exchange=z.object({id:z.uuid(),conversation_id:z.uuid(),user_message_id:z.uuid(),sequence:z.coerce.number().int(),created_at:z.string()});
export const Member=z.object({message_id:z.uuid(),exchange_id:z.uuid(),kind:z.enum(['answer','progress','unknown']),method:z.enum(['response_to','heuristic','legacy']),method_version:z.string(),run_id:z.uuid().nullable(),applied_user_ids:z.array(z.uuid())});
