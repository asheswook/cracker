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
}).refine(message => message.phase == null || message.role === "assistant", {
  path: ["phase"], message: "Only assistant messages can have a phase",
});
export const Conversation = z.object({ id: Id, title: z.string(), created_at: z.string() });
export const Task = z.object({
  lane: TaskLane.optional(),
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
export const Assignment = z.object({
  offered: z.boolean().optional(),
  lane: TaskLane.optional(),
  semantic_structure_mode: z.enum(['off','shadow','on']).optional(),
  semantic_context_enabled: z.boolean().optional(),
  task: Task,
  run_id: Id,
  model_binding: ModelBinding.optional(),
  messages: z.array(Message),
  instructions: z.string(),
  persona: Persona.optional(),
  work_context: WorkContext.optional(),
  skill_binding: z.object({skill_id:Id,revision:z.number().int().positive(),content_hash:z.string(),name:z.string()}).optional(),
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
    })
    .refine((value) => value.phase === 'final_answer' || value.content.trim().length > 0 || (value.attachment_ids?.length ?? 0) > 0),
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
