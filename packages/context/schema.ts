import { z } from "zod";
import { RetentionAssessment, RetentionContext } from "../memory/retention";

export const SemanticMode = z.enum(["live", "backfill"]);
export const SourceHash = z.string().regex(/^[a-f0-9]{64}$/);
export const Evidence = z.object({ message_id: z.uuid(), quote: z.string().min(1).max(1000) }).strict();
export const SourceFile = z.object({ id: z.uuid(), name: z.string(), media_type: z.string(), bytes: z.coerce.number().nonnegative(), sha256: SourceHash });
export const SemanticSource = z.object({ message_id: z.uuid(), conversation_id:z.uuid().nullable().default(null), task_id: z.uuid().nullable(), sequence: z.coerce.number().int().nonnegative(), role: z.enum(["user", "assistant", "system"]), content: z.string(), created_at:z.iso.datetime().nullable().default(null), content_offset:z.number().int().nonnegative().default(0), truncated: z.boolean(), sha256: SourceHash, attachments: z.array(SourceFile).max(8), retention_allowed: z.boolean(), linked_context_id:z.uuid().nullable().default(null) });
export const SemanticLink = z.object({ originating_message_id:z.uuid().nullable().default(null), message_id: z.uuid(), context_id: z.uuid(), revision: z.number().int().positive(), status: z.enum(["provisional", "confirmed"]), source_sequence: z.coerce.number().int().nonnegative(), source_sha256: SourceHash, evidence: z.array(Evidence) });
export const NoteInput = z.object({ id: z.uuid(), kind: z.enum(["fact", "decision", "open_question", "constraint", "outcome"]), text: z.string().min(1).max(1200), evidence: z.array(Evidence).min(1).max(8), supersedes: z.uuid().nullable().default(null), valid_from: z.iso.datetime().nullable().default(null), valid_to: z.iso.datetime().nullable().default(null) }).strict();
export const SemanticNote = NoteInput.extend({ source_message_id: z.uuid(), source_sequence: z.coerce.number().int().nonnegative(), source_sha256: SourceHash, context_revision: z.number().int().positive(), basis: z.enum(["user_statement", "assistant_report", "system_record"]), superseded_by: z.uuid().nullable(), recorded_at: z.string() });
export const SourceWindow=z.object({message_id:z.uuid(),start:z.number().int().nonnegative(),end:z.number().int().nonnegative()}).strict().refine(value=>value.end>value.start&&value.end-value.start<=2400,"Window must contain 1 to 2400 characters");
export const ContextRetrieval=z.object({note_ids:z.array(z.uuid()).max(16).default([]),source_windows:z.array(SourceWindow).max(8).default([])}).strict();
export const SemanticContext = z.object({ context_id: z.uuid(), title: z.string(), scope: z.string(), revision: z.number().int().nonnegative(), source_sequence: z.coerce.number().int().nonnegative(), notes: z.array(SemanticNote), recent_messages: z.array(SemanticSource), files: z.array(SourceFile), retrieval:ContextRetrieval.default({note_ids:[],source_windows:[]}) });
export const SemanticChoice = z.discriminatedUnion("kind", [z.object({ kind: z.literal("existing"), context_id: z.uuid(), expected_context_revision: z.number().int().nonnegative() }).strict(), z.object({ kind: z.literal("new"), title: z.string().trim().min(1).max(160), scope: z.string().trim().min(1).max(1200) }).strict()]);
export const SemanticDecision = z.object({ context_id: z.uuid().nullable(), outcome: z.enum(["existing", "new", "uncertain"]), scores: z.array(z.object({ context_id: z.uuid(), score: z.number().min(0).max(1), reason: z.string().max(1000) }).strict()).max(24), model: z.string().min(1).max(200) }).strict();
export const PrepareRequest = z.object({ message_id: z.uuid(), mode: SemanticMode.default("live"), history_after_sequence: z.number().int().nonnegative().optional() }).strict();
export const ReplyContext = z.object({source:SemanticSource,context:SemanticContext.nullable()});
export const PrepareResult = z.object({ source: SemanticSource, reply:ReplyContext.nullable().default(null), retention_context: RetentionContext, neighbors: z.array(SemanticSource), candidates: z.array(SemanticContext), linked: SemanticLink.nullable(), history: z.object({ messages: z.array(SemanticSource), next_after_sequence: z.number().int().nonnegative().nullable(), has_more: z.boolean() }), decision: SemanticDecision.optional() });
export const LinkRequest = z.object({ operation_id: z.uuid(), message_id: z.uuid(), mode: SemanticMode.default("live"), source_sha256: SourceHash, expected_link_revision: z.number().int().nonnegative(), choice: SemanticChoice, status: z.enum(["provisional", "confirmed"]), evidence: z.array(Evidence).min(1).max(8),note_ids:z.array(z.uuid()).max(16).default([]),source_windows:z.array(SourceWindow).max(8).default([]) }).strict();
export const LinkResult = z.object({ link: SemanticLink, context: SemanticContext });
export const NotesRequest = z.object({ operation_id: z.uuid(), context_id: z.uuid(), expected_revision: z.number().int().nonnegative(), source_message_id: z.uuid(), source_sha256: SourceHash, mode: SemanticMode.default("live"), notes: z.array(NoteInput).min(1).max(16) }).strict();
export const NotesResult = z.object({ context: SemanticContext });
export type SemanticPrepare = z.infer<typeof PrepareResult>;
export type SemanticDecisionValue = z.infer<typeof SemanticDecision>;
export type SemanticClassifier = (input: SemanticPrepare) => Promise<SemanticDecisionValue>;

export const SemanticRetrievedContext = z.object({context_id:z.uuid(),note_ids:z.array(z.uuid()).max(16).default([]),source_ids:z.array(z.uuid()).max(8).default([]),source_windows:z.array(SourceWindow).max(8).default([])}).strict().refine(value=>new Set([...value.source_ids,...value.source_windows.map(window=>window.message_id)]).size<=8,"At most eight selected sources");
export type SemanticRetriever = (input: SemanticPrepare, scope: Readonly<{ workspace: string; conversation: string }>) => Promise<readonly Readonly<{context_id:string;note_ids?:readonly string[];source_ids?:readonly string[];source_windows?:readonly Readonly<z.infer<typeof SourceWindow>>[]}>[]>;

export const SemanticRetentionRequest = z.object({ message_id: z.uuid(), mode: SemanticMode.default("live"), assessment: RetentionAssessment }).strict();
export const SemanticRetentionResult = z.object({ retention_allowed: z.boolean(), retention_context: RetentionContext });

export const SemanticSnapshotRequest = z.object({context_id:z.uuid(),mode:SemanticMode.default("live"),note_ids:z.array(z.uuid()).max(16).default([]),source_ids:z.array(z.uuid()).max(8).default([]),source_windows:z.array(SourceWindow).max(8).default([])}).strict().refine(value=>new Set([...value.source_ids,...value.source_windows.map(window=>window.message_id)]).size<=8,"At most eight selected sources");
