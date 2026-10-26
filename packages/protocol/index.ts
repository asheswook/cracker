import { RetentionContext } from "../memory/retention";
import { z } from "zod";
import { ModelBinding } from "../models/schema";

export const Id = z.uuid();
export const TaskLane = z.enum(['foreground','background']);
export const TaskState = z.enum([
  "queued",
  "running",
  "waiting",
  "pausing",
  "paused",
  "cancelling",
  "cancelled",
  "succeeded",
  "failed",
  "unknown",
]);
export const Artifact = z.object({
  id: Id,
  name: z.string(),
  media_type: z.string(),
  bytes: z.coerce.number().int().min(0),
  sha256: z.string().regex(/^[0-9a-f]{64}$/),
  state: z.enum(["ready", "deleted"]),
  created_at: z.string(),
});
export const AssistantPhase = z.enum(["commentary", "final_answer"]);
/**
 * A card inside an assistant message. `result` reports an action that already happened on the user's instruction
 * (message sent, post published, event created): it has no buttons. Later kinds (draft, decision, choices) extend this union.
 */
export const ResultBlock = z.object({
  kind: z.literal("result"),
  action: z.enum(["sent", "posted", "scheduled", "booked", "updated", "deleted", "created"]),
  channel: z.string().trim().min(1).max(80),
  target: z.string().trim().max(200).nullable(),
  title: z.string().trim().max(200).nullable(),
  body: z.string().max(4000).nullable(),
  url: z.url().max(2000).refine(u => /^https?:/.test(u)).nullable(),
  at: z.iso.datetime({ offset: true }).nullable(),
  /** The approved card this action carries out ("<message id>:<block id>"), when it carries one out. */
  card: z.string().regex(/^[0-9a-f-]{36}:[a-z0-9_-]{1,32}$/).nullable().optional(),
}).strict();
const BlockId = z.string().regex(/^[a-z0-9_-]{1,32}$/);
/** Text the assistant wrote for the user to send: shown with 보내기 / 수정 / 나중에. Nothing is sent until the user answers. */
export const DraftBlock = z.object({
  kind: z.literal("draft"), id: BlockId,
  channel: z.string().trim().min(1).max(80), target: z.string().trim().max(200).nullable(),
  title: z.string().trim().max(200).nullable(), body: z.string().min(1).max(8000),
}).strict();
/** A short decision with 2-4 options (e.g. "3층 회의실 잡을까요?" 예 / 아니요 / 다른 층). */
export const ChoiceBlock = z.object({
  kind: z.literal("choice"), id: BlockId, question: z.string().trim().min(1).max(300),
  options: z.array(z.object({ id: BlockId, label: z.string().trim().min(1).max(40) }).strict()).min(2).max(4),
}).strict();
/** On a user message: the button the user pressed on an earlier card. */
export const AnswerBlock = z.object({
  kind: z.literal("answer"), message_id: Id, block_id: BlockId,
  option: z.string().regex(/^[a-z0-9_-]{1,32}$/), label: z.string().max(40), body: z.string().max(8000).nullable(),
}).strict();
export const MessageBlock = z.discriminatedUnion("kind", [ResultBlock, DraftBlock, ChoiceBlock, AnswerBlock]);
export type MessageBlock = z.infer<typeof MessageBlock>;
export const MessageBlocks = z.array(MessageBlock).min(1).max(8);
export const Message = z.object({
  synthetic: z.boolean().optional(),
  task_status: z.object({task_id:Id,run_id:Id,state:z.enum(["failed","unknown"]),reason:z.string()}).optional(),
  id: Id,
  task_id: Id.nullable().optional(),
  conversation_id: Id,
  role: z.enum(["user", "assistant", "system"]),
  origin: z.enum(["user", "schedule", "responsibility"]).optional(),
  notify: z.boolean().optional(),
  hidden: z.boolean().optional(),
  phase: AssistantPhase.nullish(),
  content: z.string(),
  reply_to_message_id: Id.nullable().optional(),
  reply: z.object({message_id:Id,conversation_id:Id,sequence:z.coerce.number(),role:z.enum(['user','assistant','system']),content:z.string().max(500),available:z.boolean()}).nullable().optional(),
  sequence: z.coerce.number().int(),
  created_at: z.string(),
  client_message_id: Id.nullable(),
  read_at: z.string().nullable().optional(),
  attachments: z.array(Artifact).max(8).optional(),
  blocks: MessageBlocks.nullable().optional(),
  card_states: z.record(z.string(), z.object({ state: z.enum(['pending','snoozed','accepted','resolved','failed','dismissed','superseded','replaced']), option: z.string().nullable(), snoozed_until: z.string().nullable(), approved_body: z.string().nullable().optional(), retry_ok: z.boolean().optional() })).optional(),
}).refine(message => message.phase == null || message.role === "assistant", {
  path: ["phase"], message: "Only assistant messages can have a phase",
});
export const Conversation = z.object({ id: Id, title: z.string(), created_at: z.string() });
export const Task = z.object({
  lane: TaskLane.optional(),
  title: z.string().nullable().optional(),
  origin: z.enum(['user', 'schedule', 'responsibility']).optional(),
  id: Id,
  conversation_id: Id,
  objective: z.string(),
  state: TaskState,
  reason: z.string().nullable(),
  created_at: z.string(),
  updated_at: z.string(),
});
export const Command = z.object({
  id: Id,
  task_id: Id.nullable(),
  kind: z.enum(["stop", "takeover", "return_control"]),
  created_at: z.string(),
});
export const Persona = z.object({
  name: z.string().trim().min(1).max(80),
  role: z.string().max(2000),
  style: z.string().max(2000),
}).strict();
export const Onboarding = z.object({ status: z.enum(["pending", "completed", "skipped"]), updated_at: z.string().nullable() });
export const ReadReceipt = z.object({ message_id: Id, read_at: z.string() });
export const WorkCapsule = z.object({
  task_id: Id, state: TaskState, objective_excerpt: z.string().max(1200), objective_truncated: z.boolean(),
  sources: z.array(z.object({ source_message_id: Id, role: z.enum(["user", "assistant", "system"]), excerpt: z.string().max(1200), truncated: z.boolean(), attachment_ids: z.array(Id) })).max(4),
});
export const WorkContext = z.object({ prior_work: z.array(WorkCapsule).max(8), has_older_work: z.boolean(), next_before_task_id: Id.nullable() });
export const PriorWorkRequest = z.object({ task_id: Id.nullable(), before_task_id: Id.nullable(), after_sequence: z.number().int().min(0) }).strict();
export const PriorWorkPage = z.object({ capsules: z.array(WorkCapsule).max(8), messages: z.array(Message).max(100), has_more: z.boolean(), next_before_task_id: Id.nullable(), next_after_sequence: z.number().int().nullable() });
export const TaskSourcePage = z.object({ retention_context: RetentionContext.optional(), messages: z.array(Message).max(100), memory: z.array(z.object({ id: Id, text: z.string() })), next_after_sequence: z.number().int().nullable() });
export const RecoverySummary = z.object({completed_actions:z.number().int().nonnegative(),uncertain_actions:z.number().int().nonnegative(),history_available:z.boolean()});
export const RecoveryContext = RecoverySummary.extend({mode:z.literal('explain_only'),source_run_id:Id,reason:z.string().max(2000)});
export const Assignment = z.object({
  recovery: RecoveryContext.optional(),
  offered: z.boolean().optional(),
  lane: TaskLane.optional(),
  semantic_structure_mode: z.enum(['off','shadow','on']).optional(),
  knowledge_tree_mode: z.enum(['off','shadow','on']).optional(),
  semantic_context_enabled: z.boolean().optional(),
  task: Task,
  run_id: Id,
  model_binding: ModelBinding.optional(),
  messages: z.array(Message),
  instructions: z.string(),
  persona: Persona.optional(),
  work_context: WorkContext.optional(),
  skill_binding: z.object({skill_id:Id,revision:z.number().int().positive(),content_hash:z.string(),name:z.string()}).optional(),
  /** read_only: an assistant-owned look or draft run; the daemon refuses every tool that could write outside (code, not prompt). */
  run_policy: z.enum(['read_only', 'send_once', 'brief']).optional(),
  /** For a source job: the one account (Gmail) or workspace (Slack) its readers may read. */
  source_scope: z.object({ kind: z.enum(['gmail', 'slack']), account: z.string() }).optional(),
  /** For the brief: the extension servers (ids) whose calendar reads it may use. */
  calendar_servers: z.array(z.string()).optional(),
  memory: z.array(z.object({ id: Id, text: z.string() })),
});
export const DaemonPoll = z.object({
  recovery_run_id: Id.optional(),
  assignment: Assignment.nullable(),
  commands: z.array(Command),
  messages: z.array(Message),
});
export const DaemonEvent = z.discriminatedUnion("kind", [
  z.object({kind:z.literal("skill_loaded"),event_id:Id,run_id:Id,skill_id:Id,revision:z.number().int().positive(),content_hash:z.string().regex(/^[a-f0-9]{64}$/)}),
  z.object({ kind: z.literal("heartbeat"), event_id: Id, run_id: Id.optional() }),
  z
    .object({
      kind: z.literal("message"),
      event_id: Id,
      run_id: Id,
      message_id: Id.optional(),
      semantic_context_id: Id.optional(),
      semantic_source_message_id: Id.optional(),
      response_to_message_id: Id.optional(),
      applied_user_ids: z.array(Id).max(256).optional(),
      output_kind: z.enum(['answer','refusal','artifact','progress']).optional(),
      content: z.string().max(100000),
      phase: AssistantPhase.nullish(),
      attachment_ids: z.array(Id).max(8).optional(),
      blocks: MessageBlocks.optional(),
    })
    .refine((value) => value.phase === 'final_answer' || value.content.trim().length > 0 || (value.attachment_ids?.length ?? 0) > 0 || (value.blocks?.length ?? 0) > 0),
  z.object({
    kind: z.literal("state"),
    event_id: Id,
    run_id: Id,
    state: TaskState,
    reason: z.string().max(2000).nullable(),
  }),
  z.object({
    kind: z.literal("command_ack"),
    event_id: Id,
    command_id: Id,
    status: z.enum(["applied", "failed"]),
    resume_safe: z.boolean().optional(),
    execution_continues: z.boolean().optional(),
    detail: z.string().max(2000),
  }),
  z.object({ kind: z.literal("input_applied"), event_id: Id, run_id: Id, message_id: Id }),
  z.object({ kind: z.literal("activity"), event_id: Id, run_id: Id, activity: z.enum(["computer","web","code","memory"]) }),
]);
export type Assignment = z.infer<typeof Assignment>;
export type DaemonEvent = z.infer<typeof DaemonEvent>;
export type Message = z.infer<typeof Message>;
export type Task = z.infer<typeof Task>;
export type Command = z.infer<typeof Command>;

export class DomainError extends Error {
  constructor(
    readonly code: string,
    message: string,
    readonly status: 400 | 401 | 403 | 404 | 409 | 413 | 503 = 400,
  ) {
    super(message);
    this.name = "DomainError";
  }
}
