import { z } from "zod";
import { NotesRequest, ContextRetrieval, SourceHash } from "../../packages/context/schema.ts";

export const SemanticCheckpoint = z.object({
  reference: z.object({ message_id: z.uuid(), source_sha256: SourceHash, primary_retrieval: ContextRetrieval, primary_context_id: z.uuid().nullable(), selection: z.object({ status: z.enum(["confirmed", "provisional", "none"]), uncertain: z.boolean() }), alternatives: z.array(ContextRetrieval.extend({ context_id: z.uuid() })).max(3) }).optional(),
  delivery_ids: z.boolean().optional(),
  active: z.object({ context_id: z.uuid(), message_id: z.uuid() }).nullable(),
  pending: z.array(z.uuid()).max(100),
  fresh_sources: z.array(z.object({ context_id: z.uuid(), message_ids: z.array(z.uuid()).max(2000) })).max(100).optional(),
  note_batch: z.object({ context_id: z.uuid(), message_ids: z.array(z.uuid()).max(8) }).optional(),
  retrieved_notes: z.array(z.object({ context_id: z.uuid(), note_ids: z.array(z.uuid()).max(16) })).max(100).optional(),
  unindexed: z.array(z.uuid()).optional(),
  mutation: NotesRequest.optional(),
  final_cursor: z.number().int().nonnegative().optional(),
});
export type SemanticCheckpoint = z.infer<typeof SemanticCheckpoint>;
