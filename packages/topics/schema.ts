import { z } from 'zod';

const Id = z.uuid();
/** One topic chip anchor: the message it labels and the knowledge node it belongs to. */
export const TopicAssignment = z.object({ message_id: Id, node_id: Id, inherited: z.boolean() }).strict();
export const TopicNode = z.object({
  id: Id, parent_id: Id.nullable(), kind: z.enum(['topic', 'rule', 'event']),
  title: z.string(), label: z.string(), depth: z.number().int().nonnegative(),
}).strict();
export const ConversationTopics = z.object({
  assignments: z.array(TopicAssignment),
  nodes: z.array(TopicNode),
}).strict();
export type ConversationTopics = z.infer<typeof ConversationTopics>;
export const BranchMessage = z.object({
  id: Id, role: z.enum(['user', 'assistant', 'system']), content: z.string(), created_at: z.string(), node_id: Id,
  origin: z.enum(['user', 'schedule', 'responsibility']).nullable(),
}).strict();
export const TopicBranch = z.object({
  root: TopicNode, focus: TopicNode, nodes: z.array(TopicNode.extend({ messages: z.number().int().nonnegative() })),
  summary: z.array(z.string()), messages: z.array(BranchMessage),
}).strict();
export type TopicBranch = z.infer<typeof TopicBranch>;

/** Chip label: the node title cut at a natural boundary so a chip never wraps. The full title stays in the sheet. */
export function topicLabel(title: string, max = 24): string {
  const clean = title.replace(/\s+/g, ' ').trim();
  if (clean.length <= max) return clean;
  // Parenthetical detail (dates, examples) goes first; the remaining phrase usually still names the topic.
  const bare = clean.replace(/\s*[(\[（][^)\]）]*[)\]）]\s*/g, ' ').replace(/\s+/g, ' ').trim();
  if (bare.length >= 4 && bare.length <= max) return bare;
  // Slightly long: drop trailing words ("매 시간 Slack·Gmail 트래킹 점검 알림" → "매 시간 Slack·Gmail 트래킹 점검").
  if (bare.length <= max + 6) {
    const words = bare.split(' ');
    while (words.length > 2 && words.join(' ').length > max) words.pop();
    while (words.length > 2 && /^[+&=>\-–—]$/.test(words.at(-1) ?? '')) words.pop();
    // A dangling connector ("회의 + 17-B") means the cut fell inside a second clause; keep the first clause instead.
    const plus = words.indexOf('+');
    if (plus > 1) words.length = plus;
    const joined = words.join(' ');
    if (joined.length <= max && joined.length >= 10) return joined;
  }
  // Long "A·B·C" lists: drop trailing items while the phrase stays meaningful.
  let trimmed = bare;
  while (trimmed.length > max && trimmed.includes('·')) {
    const next = trimmed.replace(/·[^·]+$/, '');
    if (next.length < 10) break;
    trimmed = next;
  }
  if (trimmed.length <= max && trimmed.length >= 10) return trimmed;
  const head = bare.split(/\s*[:：|/+]\s*|\s+[-–—]\s+|,\s*|\s*=>\s*/)[0] ?? bare;
  if (head.length >= 10 && head.length <= max) return head;
  const cut = bare.slice(0, max);
  const space = cut.lastIndexOf(' ');
  return `${(space >= 8 ? cut.slice(0, space) : cut).replace(/[,·:\s]+$/, '')}…`;
}
