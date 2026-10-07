import { z } from "zod";
import { SemanticLink, SemanticMode } from "./schema";
const Target=z.discriminatedUnion('kind',[
 z.object({kind:z.literal('existing'),context_id:z.uuid()}).strict(),
 z.object({kind:z.literal('new'),key:z.string().min(1).max(80),title:z.string().trim().min(1).max(160),scope:z.string().trim().min(1).max(1200)}).strict(),
]);
export const ContextRevision=z.object({context_id:z.uuid(),revision:z.number().int().nonnegative()}).strict();
export const AutomaticReview=z.object({confidence:z.number().min(0).max(1),margin:z.number().min(0).max(1),evidence:z.array(z.object({message_id:z.uuid(),quote:z.string().min(1).max(1200)}).strict()).min(1).max(16)}).strict();
export const ReorganizeRequest=z.object({
 operation_id:z.uuid(),conversation_id:z.uuid(),mode:SemanticMode.default('live'),intent:z.enum(['propose','apply']).default('propose'),
 contexts:z.array(z.object({context_id:z.uuid(),expected_revision:z.number().int().nonnegative()}).strict()).min(1).max(128),
 moves:z.array(z.object({message_id:z.uuid(),expected_link_revision:z.number().int().positive(),to:Target}).strict()).min(1).max(4096),
 reason:z.string().trim().min(1).max(1200),proposal_id:z.uuid().nullable().default(null),
 automatic_review:AutomaticReview.optional(),
}).strict();
export const UndoReorganizationRequest=z.object({operation_id:z.uuid(),undo_operation_id:z.uuid(),conversation_id:z.uuid(),mode:SemanticMode.default('live')}).strict();
export const OrganizationResult=z.object({
 operation_id:z.uuid(),status:z.enum(['proposal','applied','undone']),
 moves:z.array(z.object({before:SemanticLink,after:SemanticLink}).strict()).max(4096),
 contexts:z.array(ContextRevision).max(128),created_context_ids:z.array(z.uuid()).max(64),
}).strict();
