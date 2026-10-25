import { z } from 'zod';

export const TopicNode = z.object({
  id: z.uuid(), parent_id: z.uuid().nullable(), kind: z.enum(['topic', 'rule', 'event']),
  title: z.string(), label: z.string(), depth: z.number().int().nonnegative(),
});
export type TopicNode = z.infer<typeof TopicNode>;
export const ConversationTopics = z.object({
  assignments: z.array(z.object({ message_id: z.uuid(), node_id: z.uuid(), inherited: z.boolean() })),
  nodes: z.array(TopicNode),
});
/** One line of a branch's work: a waiting card, a running task, a result, or a decision already made. */
export const BranchWorkItem = z.object({
  id: z.string(), kind: z.enum(['card', 'task', 'result', 'decision']),
  title: z.string(), detail: z.string().nullable(), state: z.string(), at: z.string(), message_id: z.uuid().nullable(),
});
export type BranchWorkItem = z.infer<typeof BranchWorkItem>;
export const TopicBranch = z.object({
  root: TopicNode, focus: TopicNode,
  nodes: z.array(TopicNode.extend({ messages: z.number().int().nonnegative() })),
  summary: z.array(z.string()),
  messages: z.array(z.object({
    id: z.uuid(), role: z.enum(['user', 'assistant', 'system']), content: z.string(), created_at: z.string(), node_id: z.uuid(),
    origin: z.enum(['user', 'schedule', 'responsibility']).nullable(),
  })),
  work: z.object({
    needs_you: z.array(BranchWorkItem), in_progress: z.array(BranchWorkItem), results: z.array(BranchWorkItem), decisions: z.array(BranchWorkItem),
  }).optional(),
});
export type TopicBranch = z.infer<typeof TopicBranch>;
