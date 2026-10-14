import { z } from 'zod';
import { ReplyHandoffState } from '../../../packages/protocol/composing';
export const Id = z.string().uuid().brand<'Id'>();
export type Id = z.infer<typeof Id>;
export const Conversation = z.object({ id: Id, title: z.string(), created_at: z.string(), preview: z.string().nullable().optional(), last_message_at: z.string().nullable().optional(), message_count: z.number().int().optional() });
export type Conversation = z.infer<typeof Conversation>;
export const Persona = z.object({ name: z.string(), role: z.string(), style: z.string() });
export type Persona = z.infer<typeof Persona>;
export const Artifact = z.object({
  id: Id,
  name: z.string(),
  media_type: z.string(),
  bytes: z.coerce.number(),
  sha256: z.string(),
  state: z.enum(['ready', 'deleted']),
  created_at: z.string(),
});
export type Artifact = z.infer<typeof Artifact>;
export const MessageReply = z.object({ message_id: Id, conversation_id: Id, sequence: z.coerce.number(),
  role: z.enum(['user', 'assistant', 'system']), content: z.string().max(500), available: z.boolean() });
export type MessageReply = z.infer<typeof MessageReply>;
export const Message = z.object({
  id: Id,
  conversation_id: Id,
  role: z.enum(['user', 'assistant', 'system']),
  origin: z.enum(['user', 'schedule', 'responsibility']).optional(),
  notify: z.boolean().optional(),
  task_id: Id.nullable().optional(),
  task_status: z.object({ task_id: Id, run_id: Id, state: z.enum(['failed', 'unknown']), reason: z.string() }).optional(),
  content: z.string(),
  reply_to_message_id: Id.nullable().optional(),
  reply: MessageReply.nullable().optional(),
  attachments: Artifact.array().optional(),
  sequence: z.coerce.number(),
  created_at: z.string(),
  client_message_id: Id.nullable(),
  read_at: z.string().nullable().optional(),
});
export type Message = z.infer<typeof Message>;
export const Task = z.object({
  id: Id,
  conversation_id: Id,
  objective: z.string(),
  state: z.string(),
  reason: z.string().nullable(),
  created_at: z.string(),
  updated_at: z.string(),
});
export type Task = z.infer<typeof Task>;
export const Vm = z.object({
  id: Id,
  name: z.string(),
  last_seen_at: z.string().nullable(),
  control_state: z.enum(['agent', 'user', 'switching', 'unknown']),
  online: z.boolean().default(true),
});
export type Vm = z.infer<typeof Vm>;
export const Schedule = z.object({
  id: Id,
  conversation_id: Id,
  objective: z.string(),
  due_at: z.string(),
  timezone: z.string(),
  status: z.string(),
  task: Task.nullable().optional(),
  skill_id: Id.nullable().optional(),
  skill_revision: z.coerce.number().int().positive().nullable().optional(),
});
export type Schedule = z.infer<typeof Schedule>;
export const Memory = z.object({
  id: Id, text: z.string(), created_at: z.string().optional(),
  source_message_id: Id.nullable().optional(), provenance: z.enum(['extracted', 'user_note', 'user_correction']).optional(),
  epistemic_status: z.enum(['reported', 'inferred', 'disputed']).optional(), conversation_id: Id.nullable().optional(),
  context: z.string().nullable().optional(), predicate: z.string().nullable().optional(), source_excerpt: z.string().nullable().optional(),
  source_role: z.enum(['user', 'assistant', 'system']).nullable().optional(), source_created_at: z.string().nullable().optional(),
  valid_from: z.string().nullable().optional(), valid_to: z.string().nullable().optional(), known_from: z.string().optional(),
  root_memory_id: Id.optional(), supersedes_id: Id.nullable().optional(),
});
export type Memory = z.infer<typeof Memory>;
export const Pending = z.object({
  client_message_id: Id,
  conversation_id: Id,
  content: z.string(),
  reply_to_message_id: Id.nullable().optional(),
  reply: MessageReply.nullable().optional(),
  attachments: Artifact.array().optional(),
  created_at: z.string(),
  state: z.enum(['queued', 'sending', 'failed']),
});
export type Pending = z.infer<typeof Pending>;
export const Session = z.object({ workspace_id: Id });
export const Resources = {
  conversations: z.object({ conversations: Conversation.array() }),
  tasks: z.object({ tasks: Task.array() }),
  vms: z.object({ vms: Vm.array() }),
  schedules: z.object({ schedules: Schedule.array() }),
  memories: z.object({ memories: Memory.array() }),
};
export const ReplyComposing=z.object({task_id:Id,run_id:Id,inference_id:Id,generation:z.coerce.number().int().positive(),response_id:z.string(),item_id:z.string(),input_message_ids:Id.array(),expires_at:z.string()});
export type ReplyComposing=z.infer<typeof ReplyComposing>;
export const ReplyHandoff = ReplyHandoffState;
export type ReplyHandoff = z.infer<typeof ReplyHandoff>;
export const AssistantWorking = z.object({ task_id: Id, run_id: Id, input_message_id: Id, expires_at: z.iso.datetime(), activity: z.enum(['computer']).nullable().default(null) });
export type AssistantWorking = z.infer<typeof AssistantWorking>;
export const MessagePage = z.object({
  background: z.object({count:z.number().int().nonnegative(),items:z.array(z.object({task_id:Id,objective:z.string().max(140),state:z.enum(['queued','running','waiting','paused']),started_at:z.string().nullable()}))}).optional(),
  composing:ReplyComposing.nullable().default(null),
  reply_handoff: ReplyHandoff.nullable().optional(),
  working: AssistantWorking.nullable().default(null),
  messages: Message.array(),
  cursor: z.coerce.number(),
  receipts: z.object({ message_id: Id, read_at: z.string() }).array().default([]),
});
