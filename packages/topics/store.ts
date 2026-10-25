/**
 * Read-only topic view over the knowledge tree. Never writes tree state.
 *
 * A message's topic is the owner node of the exchange it belongs to:
 * - user message: its own owner membership;
 * - assistant reply: the user message it responds to (response_to_message_id, else the latest user message of its task);
 * - scheduled / standing-responsibility output: the owner node of the user message that registered the schedule or
 *   responsibility (schedules.source_message_id via the wake's client_message_id; responsibilities via
 *   responsibility_actions.task_id);
 * - a user turn without an owner (short acknowledgement, noise, not yet grown) inherits the previous labelled exchange
 *   when it follows within 30 minutes.
 * Merged nodes resolve to their survivor.
 */
import type { Query } from '../../services/control/db';
import { z } from 'zod';
import { topicLabel, type ConversationTopics, type TopicBranch } from './schema';

const INHERIT_MS = 30 * 60 * 1000;
const NodeRow = z.object({ id: z.uuid(), parent_id: z.uuid().nullable(), kind: z.enum(['topic', 'rule', 'event']), title: z.string(), depth: z.coerce.number().int(), status: z.string(), merged_into: z.uuid().nullable(), summary: z.unknown() });
type NodeRow = z.infer<typeof NodeRow>;

async function liveNodes(sql: Query, workspace: string) {
  const rows = z.array(NodeRow).parse(await sql`SELECT id,parent_id,kind,title,depth,status,merged_into,summary FROM assistant.knowledge_nodes WHERE workspace_id=${workspace}`);
  const byId = new Map(rows.map(r => [r.id, r]));
  const live = (id: string | null | undefined): string | null => {
    let cur = id ?? null; const seen = new Set<string>();
    while (cur && byId.get(cur)?.status === 'merged' && !seen.has(cur)) { seen.add(cur); cur = byId.get(cur)?.merged_into ?? null; }
    return cur && byId.has(cur) ? cur : null;
  };
  return { byId, live };
}
const view = (n: NodeRow) => ({ id: n.id, parent_id: n.parent_id, kind: n.kind, title: n.title, label: topicLabel(n.title), depth: n.depth });

const Msg = z.object({ id: z.uuid(), role: z.enum(['user', 'assistant', 'system']), task_id: z.uuid().nullable(), response_to_message_id: z.uuid().nullable(), client_message_id: z.string().nullable(), origin: z.enum(['user', 'schedule', 'responsibility']).nullable(), created_at: z.coerce.date(), synthetic: z.boolean(), sequence: z.coerce.number() });

/** Topic per message of one conversation (messages after `after`, plus enough history to resolve inheritance). */
export async function conversationTopics(sql: Query, workspace: string, conversation: string, after = 0): Promise<ConversationTopics> {
  const { byId, live } = await liveNodes(sql, workspace);
  // Look back far enough that inheritance and task replies resolve for the first requested message.
  const msgs = z.array(Msg).parse(await sql`
    SELECT id,role,task_id,response_to_message_id,client_message_id,origin,created_at,synthetic,sequence FROM assistant.messages
    WHERE workspace_id=${workspace} AND conversation_id=${conversation}
      AND sequence > GREATEST(0, ${after} - 400) ORDER BY sequence`);
  const owners = new Map(z.array(z.object({ user_message_id: z.uuid(), node_id: z.uuid() })).parse(await sql`
    SELECT k.user_message_id,k.node_id FROM assistant.knowledge_node_members k JOIN assistant.messages m ON m.workspace_id=k.workspace_id AND m.id=k.user_message_id
    WHERE k.workspace_id=${workspace} AND k.role='owner' AND m.conversation_id=${conversation} AND m.sequence > GREATEST(0, ${after} - 400)`).map(r => [r.user_message_id, r.node_id]));
  const noise = new Set(z.array(z.object({ user_message_id: z.uuid() })).parse(await sql`
    SELECT z.user_message_id FROM assistant.knowledge_noise z JOIN assistant.messages m ON m.workspace_id=z.workspace_id AND m.id=z.user_message_id
    WHERE z.workspace_id=${workspace} AND m.conversation_id=${conversation} AND m.sequence > GREATEST(0, ${after} - 400)`).map(r => r.user_message_id));
  // Background tasks → registering user message.
  const bgTasks = [...new Set(msgs.filter(m => m.origin === 'schedule' || m.origin === 'responsibility').map(m => m.task_id).filter((t): t is string => !!t))];
  const wakeSchedule = msgs.filter(m => m.origin === 'schedule' && m.role === 'system' && m.client_message_id).map(m => m.client_message_id as string).filter(id => z.uuid().safeParse(id).success);
  const sources = new Map<string, string>();
  if (bgTasks.length) {
    for (const r of z.array(z.object({ task_id: z.uuid(), source: z.uuid() })).parse(await sql`
      SELECT a.task_id, r.source_message_id AS source FROM assistant.responsibility_actions a JOIN assistant.responsibilities r ON r.id=a.responsibility_id AND r.workspace_id=a.workspace_id
      WHERE a.workspace_id=${workspace} AND a.task_id = ANY(${sql.array(bgTasks)}::uuid[]) AND r.source_message_id IS NOT NULL`)) sources.set(r.task_id, r.source);
  }
  if (wakeSchedule.length) {
    const bySchedule = new Map(z.array(z.object({ id: z.uuid(), source: z.uuid() })).parse(await sql`
      SELECT id, source_message_id AS source FROM assistant.schedules WHERE workspace_id=${workspace} AND id = ANY(${sql.array(wakeSchedule)}::uuid[]) AND source_message_id IS NOT NULL`).map(r => [r.id, r.source]));
    for (const m of msgs) if (m.origin === 'schedule' && m.role === 'system' && m.task_id && m.client_message_id && bySchedule.has(m.client_message_id)) sources.set(m.task_id, bySchedule.get(m.client_message_id) as string);
  }
  const sourceIds = [...new Set(sources.values())].filter(id => !owners.has(id));
  if (sourceIds.length) for (const r of z.array(z.object({ user_message_id: z.uuid(), node_id: z.uuid() })).parse(await sql`
    SELECT user_message_id,node_id FROM assistant.knowledge_node_members WHERE workspace_id=${workspace} AND role='owner' AND user_message_id = ANY(${sql.array(sourceIds)}::uuid[])`)) owners.set(r.user_message_id, r.node_id);

  const userNode = new Map<string, { node: string; inherited: boolean }>();
  const taskUser = new Map<string, string>();
  let prev: { node: string; at: number } | null = null;
  const out: ConversationTopics['assignments'] = [];
  const used = new Set<string>();
  for (const m of msgs) {
    let node: string | null = null, inherited = false;
    if (m.role === 'user' && !m.synthetic) {
      if (m.task_id) taskUser.set(m.task_id, m.id);
      const own = noise.has(m.id) ? null : live(owners.get(m.id));
      if (own) node = own;
      else if (prev && m.created_at.getTime() - prev.at < INHERIT_MS) { node = prev.node; inherited = true; }
      if (node) { userNode.set(m.id, { node, inherited }); prev = { node, at: m.created_at.getTime() }; }
    } else if (m.origin === 'schedule' || m.origin === 'responsibility') {
      const src = m.task_id ? sources.get(m.task_id) : undefined;
      node = src ? live(owners.get(src)) : null;
    } else if (m.role === 'assistant') {
      const src = m.response_to_message_id ?? (m.task_id ? taskUser.get(m.task_id) : undefined);
      const hit = src ? userNode.get(src) : undefined;
      if (hit) { node = hit.node; inherited = hit.inherited; }
    }
    if (node && m.sequence > after) { out.push({ message_id: m.id, node_id: node, inherited }); used.add(node); }
  }
  // Include ancestors so the client can show the branch name without another round trip.
  for (const id of [...used]) { let cur = byId.get(id)?.parent_id ?? null; while (cur && !used.has(cur)) { const l = live(cur); if (!l) break; used.add(l); cur = byId.get(l)?.parent_id ?? null; } }
  return { assignments: out, nodes: [...used].flatMap(id => { const n = byId.get(id); return n ? [view(n)] : []; }) };
}

/** The whole top-level branch of a node, with the conversation messages that belong to it (chronological). */
export async function topicBranch(sql: Query, workspace: string, nodeId: string, limit = 400): Promise<TopicBranch | null> {
  const { byId, live } = await liveNodes(sql, workspace);
  const focusId = live(nodeId);
  if (!focusId) return null;
  let rootId = focusId; const seen = new Set<string>();
  while (byId.get(rootId)?.parent_id && !seen.has(rootId)) { seen.add(rootId); const p = live(byId.get(rootId)?.parent_id); if (!p) break; rootId = p; }
  const children = new Map<string, string[]>();
  for (const n of byId.values()) if (n.status !== 'merged' && n.parent_id) { const p = live(n.parent_id); if (p) children.set(p, [...(children.get(p) ?? []), n.id]); }
  const subtree: string[] = []; const stack = [rootId];
  while (stack.length) { const id = stack.pop() as string; if (subtree.includes(id)) continue; subtree.push(id); stack.push(...(children.get(id) ?? [])); }
  const rows = z.array(z.object({ id: z.uuid(), role: z.enum(['user', 'assistant', 'system']), content: z.string(), created_at: z.coerce.date(), node_id: z.uuid(), origin: z.enum(['user', 'schedule', 'responsibility']).nullable() })).parse(await sql`
    WITH owned AS (
      SELECT k.user_message_id, k.node_id FROM assistant.knowledge_node_members k
      LEFT JOIN assistant.knowledge_noise z ON z.workspace_id=k.workspace_id AND z.user_message_id=k.user_message_id
      WHERE k.workspace_id=${workspace} AND k.role='owner' AND k.node_id = ANY(${sql.array(subtree)}::uuid[]) AND z.user_message_id IS NULL
    )
    SELECT m.id, m.role, m.content, m.created_at, o.node_id, m.origin FROM owned o JOIN assistant.messages m ON m.workspace_id=${workspace} AND m.id=o.user_message_id
    UNION ALL
    SELECT a.id, a.role, a.content, a.created_at, o.node_id, a.origin FROM owned o JOIN assistant.messages u ON u.workspace_id=${workspace} AND u.id=o.user_message_id
      JOIN assistant.messages a ON a.workspace_id=${workspace} AND a.role='assistant' AND NOT a.hidden AND a.content<>''
       AND (a.response_to_message_id=u.id OR (a.response_to_message_id IS NULL AND a.task_id=u.task_id AND u.task_id IS NOT NULL))
    ORDER BY created_at DESC LIMIT ${limit}`);
  const counts = new Map<string, number>();
  for (const r of rows) if (r.role === 'user') counts.set(r.node_id, (counts.get(r.node_id) ?? 0) + 1);
  const focus = byId.get(focusId) as NodeRow, root = byId.get(rootId) as NodeRow;
  const summary = z.array(z.object({ text: z.string() }).passthrough()).catch([]).parse(focus.summary).map(f => f.text).slice(0, 8);
  return {
    root: view(root), focus: view(focus),
    nodes: subtree.flatMap(id => { const n = byId.get(id); return n && n.status !== 'merged' && (counts.get(id) || id === rootId || id === focusId) ? [{ ...view(n), messages: counts.get(id) ?? 0 }] : []; }).sort((a, b) => a.depth - b.depth),
    summary,
    messages: rows.reverse().map(r => ({ id: r.id, role: r.role, content: r.content.slice(0, 4000), created_at: r.created_at.toISOString(), node_id: r.node_id, origin: r.origin })),
  };
}
