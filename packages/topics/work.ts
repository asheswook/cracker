/**
 * The work of a topic branch, for the branch sheet: what is waiting for the user, what is running, what came out of it,
 * and the decisions already made. Read only; it joins the branch's messages (from topicBranch) to tasks, cards and
 * results, so it never touches knowledge-tree code.
 */
import { z } from 'zod';
import type { Query } from '../../services/control/db';
import { MessageBlocks } from '../protocol';

export const BranchWorkItem = z.object({
  id: z.string(), kind: z.enum(['card', 'task', 'result', 'decision']),
  title: z.string(), detail: z.string().nullable(), state: z.string(), at: z.string(), message_id: z.uuid().nullable(),
}).strict();
export const BranchWork = z.object({
  needs_you: z.array(BranchWorkItem), in_progress: z.array(BranchWorkItem),
  results: z.array(BranchWorkItem), decisions: z.array(BranchWorkItem),
}).strict();
export type BranchWork = z.infer<typeof BranchWork>;

const line = (s: string, max = 120) => { const t = s.split(/\r?\n/).map(l => l.trim()).find(Boolean) ?? ''; return t.length > max ? `${t.slice(0, max)}…` : t; };
const iso = (v: unknown) => (v instanceof Date ? v : new Date(String(v))).toISOString();

/** messageIds: the branch's message ids (user and assistant) as returned by topicBranch. */
export async function branchWork(sql: Query, workspace: string, messageIds: readonly string[]): Promise<BranchWork> {
  const empty: BranchWork = { needs_you: [], in_progress: [], results: [], decisions: [] };
  if (!messageIds.length) return empty;
  const ids = sql.array([...messageIds]);
  const [tasks, cards] = await Promise.all([
    sql`SELECT DISTINCT t.id,t.objective,t.state,t.reason,t.updated_at,
          (SELECT m.id FROM assistant.messages m WHERE m.task_id=t.id AND m.role='user' ORDER BY m.sequence LIMIT 1) AS first_message
        FROM assistant.messages m JOIN assistant.tasks t ON t.id=m.task_id AND t.workspace_id=m.workspace_id
        WHERE m.workspace_id=${workspace} AND m.id=ANY(${ids}::uuid[]) AND t.lane='foreground'
          AND t.state IN ('queued','running','waiting','pausing','paused','cancelling','unknown','failed')`,
    sql`SELECT m.id,m.blocks,m.created_at,m.task_id,c.block_id,c.state,c.option,c.updated_at,
          (SELECT a.blocks FROM assistant.messages a WHERE a.id=c.answer_message_id) AS answer
        FROM assistant.messages m JOIN assistant.card_states c ON c.workspace_id=m.workspace_id AND c.message_id=m.id
        WHERE m.workspace_id=${workspace} AND (m.id=ANY(${ids}::uuid[]) OR m.task_id IN (SELECT task_id FROM assistant.messages WHERE workspace_id=${workspace} AND id=ANY(${ids}::uuid[]) AND task_id IS NOT NULL))`,
  ]);
  const results = await sql`SELECT m.id,m.blocks,m.created_at FROM assistant.messages m
    WHERE m.workspace_id=${workspace} AND m.role='assistant' AND NOT m.hidden AND m.blocks @> '[{"kind":"result"}]'
      AND (m.id=ANY(${ids}::uuid[]) OR m.task_id IN (SELECT task_id FROM assistant.messages WHERE workspace_id=${workspace} AND id=ANY(${ids}::uuid[]) AND task_id IS NOT NULL))
    ORDER BY m.created_at DESC LIMIT 20`;
  const out: BranchWork = { needs_you: [], in_progress: [], results: [], decisions: [] };
  const cardTasks = new Set<string>();
  for (const row of cards) {
    const b = MessageBlocks.catch([]).parse(row['blocks']).find(x => (x.kind === 'draft' || x.kind === 'choice') && x.id === row['block_id']);
    if (!b || (b.kind !== 'draft' && b.kind !== 'choice')) continue;
    if (row['task_id']) cardTasks.add(String(row['task_id']));
    const title = b.kind === 'draft' ? `${b.channel}${b.target ? ` · ${b.target}` : ''}` : b.question;
    const state = String(row['state']);
    const answer = MessageBlocks.catch([]).parse(row['answer']).find(x => x.kind === 'answer');
    const item = { id: `card:${row['id']}:${b.id}`, title, message_id: String(row['id']), at: iso(state === 'pending' ? row['created_at'] : row['updated_at']) };
    if (state === 'pending' || state === 'snoozed') out.needs_you.push({ ...item, kind: 'card', state: b.kind, detail: b.kind === 'draft' ? line(b.body) : b.options.filter(o => o.id !== 'later').map(o => o.label).join(' / ') });
    else if (state === 'accepted') out.in_progress.push({ ...item, kind: 'card', state, detail: answer && answer.kind === 'answer' ? answer.label : null });
    else if (state !== 'replaced' && state !== 'superseded') out.decisions.push({ ...item, kind: 'decision', state,
      detail: answer && answer.kind === 'answer' ? answer.label : state === 'dismissed' ? '필요 없음' : null });
  }
  for (const t of tasks) {
    if (cardTasks.has(String(t['id']))) continue;
    const stopped = t['state'] === 'failed' || t['state'] === 'unknown';
    out.in_progress.push({ id: `task:${t['id']}`, kind: 'task', title: line(String(t['objective']), 90), detail: t['reason'] ? line(String(t['reason'])) : null,
      state: stopped ? 'stopped' : String(t['state']), at: iso(t['updated_at']), message_id: t['first_message'] ? String(t['first_message']) : null });
  }
  for (const row of results) for (const b of MessageBlocks.catch([]).parse(row['blocks'])) if (b.kind === 'result')
    out.results.push({ id: `result:${row['id']}`, kind: 'result', title: `${b.channel}${b.title ? ` · ${b.title}` : ''}`, detail: b.target, state: b.action, at: iso(row['created_at']), message_id: String(row['id']) });
  const newest = (a: { at: string }, b: { at: string }) => b.at.localeCompare(a.at);
  out.needs_you.sort(newest); out.in_progress.sort(newest); out.decisions.sort(newest);
  return BranchWork.parse(out);
}
