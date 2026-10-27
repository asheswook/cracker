/**
 * "피드": what needs the user, what is in progress, what just finished. Read-only over existing tables.
 * - needs_you: decisions only — draft/choice cards that are pending or whose snooze has ended (no date window).
 * - in_progress: approved cards being carried out, running/queued tasks, foreground requests that stopped, standing
 *   responsibilities and pending schedules.
 * - done: cards resolved or failed and result cards of the last 48 hours.
 * Each item points back into the conversation (message id) so the client can jump there.
 */
import { z } from 'zod';
import { sourceView } from './sources';
import type { Query } from '../../services/control/db';
import { MessageBlocks } from '../protocol';
import { topicLabel } from '../topics/schema';

export const AttentionItem = z.object({
  id: z.string(), kind: z.enum(['card', 'task', 'responsibility', 'schedule', 'result', 'mail', 'watch', 'send']),
  title: z.string(), detail: z.string().nullable(), at: z.string(),
  conversation_id: z.uuid(), message_id: z.uuid().nullable(), state: z.string().nullable(),
  topic: z.string().nullable().default(null),
  /** Content version (mail threads): a change makes the item news again. */
  version: z.string().nullable().default(null),
  url: z.string().nullable().default(null),
  /** For an unconfirmed reply: the send operation the actions apply to. */
  send_task_id: z.uuid().nullable().default(null),
  /** For mail: what the user has to do (reply, review, act), so the headline says it. */
  action: z.string().nullable().default(null),
  /** For a reply the user is waiting for: since when (the feed says "3일째"). */
  waiting_since: z.string().nullable().default(null),
  /** Why the user said it is stuck, if they did. */
  blocked: z.string().nullable().default(null),
  /** Where it happened (Gmail, Slack, the channel of a result) and who it is about, for a feed headline. */
  source: z.string().nullable().default(null),
  who: z.string().nullable().default(null),
});
export type AttentionItem = z.input<typeof AttentionItem> & Pick<z.infer<typeof AttentionItem>, 'id' | 'kind' | 'title' | 'detail' | 'at' | 'conversation_id' | 'message_id' | 'state'>;
/** Today's delivered morning brief (shown at the top of the feed), if any. */
const Brief = z.object({ body: z.string(), at: z.string(), conversation_id: z.uuid().nullable(), message_id: z.uuid().nullable() });
export const Attention = z.object({ needs_you: z.array(AttentionItem), in_progress: z.array(AttentionItem), done: z.array(AttentionItem), dismissed_offers: z.array(z.string()).default([]), brief: Brief.nullable().default(null) });
export type Attention = z.infer<typeof Attention>;

// One line per thread: the reply draft's state is part of the mail item, not a second item.
/** The reply draft's effective state for its mail item (a timed snooze that ended is pending again). */
const draftState = (i: Record<string, unknown>) => {
  const state = i['draft_state'] == null ? null : String(i['draft_state']);
  if (state === 'snoozed' && i['snoozed_until'] && new Date(String(i['snoozed_until'])) <= new Date()) return 'pending';
  if (state === 'accepted' && i['send_task'] === 'needs_user') return 'needs_user';
  if (state === 'accepted' && (i['send_task'] === 'checking' || i['send_task'] === 'unknown')) return 'checking';
  if (!state && (i['draft_job'] === 'failed' || i['draft_job'] === 'expired')) return 'draft_failed';
  return state;
};
const draftNote = (state: string | null, preparing: unknown) => preparing ? '답장 초안 준비 중' : state === 'pending' ? '답장 초안 준비됨' : state === 'snoozed' ? '답장 초안 미뤄 둠'
  : state === 'accepted' ? '답장 보내는 중' : state === 'checking' || state === 'needs_user' ? '답장이 나갔는지 확인 중' : state === 'failed' ? '답장 못 보냄 · 다시 보낼 수 있어요'
  : state === 'resolved' ? '답장 보냄 · 상대 회신 확인 대기' : state === 'draft_failed' ? '초안을 만들지 못했어요 · 원문에서 직접 답해 주세요' : null;
const iso = (v: unknown) => (v instanceof Date ? v : new Date(String(v))).toISOString();
// Objectives often open with tool instructions ("'X' 스킬을 먼저 로드해 …"); show what the work is about instead.
const objectiveLine = (s: string) => firstLine(s.replace(/^\s*'[^']+'\s*스킬을\s*(?:먼저\s*)?로드해\s*(?:그\s*)?절차(?:대로)?\s*/, '').replace(/^(?:매일|매시간|매 시간)\s*/, m => m), 90);
const firstLine = (s: string, max = 120) => { const line = s.split(/\r?\n/).map(l => l.trim()).find(Boolean) ?? ''; return line.length > max ? `${line.slice(0, max)}…` : line; };

/** options.doneSince: a brief asks for everything finished since it last reported, instead of the panel's 48 hours. */
export async function attention(sql: Query, workspace: string, options: { readonly doneSince?: Date } = {}): Promise<Attention> {
  const since = options.doneSince ?? new Date(Date.now() - 48 * 3_600_000);
  const resultSince = options.doneSince ?? new Date(Date.now() - 14 * 86_400_000);
  const [cards, tasks, responsibilities, schedules, results, artifacts] = await Promise.all([
    // Open cards: no date window, so an old unanswered decision never silently disappears.
    sql`SELECT m.id,m.conversation_id,m.blocks,m.content,m.created_at,c.block_id,c.state AS card_state,c.snoozed_until,c.updated_at AS card_updated,c.task_id AS card_task,(SELECT ct.state FROM assistant.tasks ct WHERE ct.id=c.task_id) AS card_task_state,
          (SELECT n.title FROM assistant.messages u JOIN assistant.knowledge_node_members k ON k.workspace_id=u.workspace_id AND k.user_message_id=u.id AND k.role='owner'
             JOIN assistant.knowledge_nodes n ON n.workspace_id=k.workspace_id AND n.id=k.node_id
           WHERE u.workspace_id=m.workspace_id AND u.task_id=m.task_id AND u.role='user' ORDER BY u.sequence LIMIT 1) AS topic
        FROM assistant.card_states c JOIN assistant.messages m ON m.workspace_id=c.workspace_id AND m.id=c.message_id LEFT JOIN assistant.tasks t ON t.id=m.task_id
        WHERE c.workspace_id=${workspace} AND (c.state='pending' OR (c.state='snoozed' AND c.snoozed_until<=now()) OR c.state='accepted'
              OR (c.state IN ('resolved','failed') AND c.updated_at>${since}))
        AND coalesce(t.objective,'') !~* '^\s*QA' AND NOT EXISTS(SELECT 1 FROM assistant.attention_source_drafts d WHERE d.card_message_id=m.id) ORDER BY m.created_at DESC LIMIT 100`,
    sql`SELECT t.id,t.conversation_id,t.objective,t.title AS task_title,t.state,t.reason,t.lane,t.origin,t.updated_at,
        EXISTS(SELECT 1 FROM assistant.attention_source_sends x WHERE x.task_id=t.id UNION ALL SELECT 1 FROM assistant.attention_source_check_tasks x WHERE x.task_id=t.id) AS internal,
        (SELECT m.id FROM assistant.messages m WHERE m.task_id=t.id AND m.workspace_id=t.workspace_id AND NOT m.hidden ORDER BY m.sequence LIMIT 1) AS first_message,
        COALESCE(
          (SELECT n.title FROM assistant.messages u JOIN assistant.knowledge_node_members k ON k.workspace_id=u.workspace_id AND k.user_message_id=u.id AND k.role='owner'
             JOIN assistant.knowledge_nodes n ON n.workspace_id=k.workspace_id AND n.id=k.node_id WHERE u.task_id=t.id AND u.role='user' ORDER BY u.sequence LIMIT 1),
          (SELECT n.title FROM assistant.responsibility_actions a JOIN assistant.responsibilities r ON r.id=a.responsibility_id
             JOIN assistant.knowledge_node_members k ON k.workspace_id=r.workspace_id AND k.user_message_id=r.source_message_id AND k.role='owner'
             JOIN assistant.knowledge_nodes n ON n.workspace_id=k.workspace_id AND n.id=k.node_id WHERE a.task_id=t.id LIMIT 1)) AS topic
        FROM assistant.tasks t WHERE t.workspace_id=${workspace}
        AND (t.state IN ('queued','running','waiting','pausing','paused','cancelling') OR (t.state IN ('failed','unknown') AND t.updated_at>now()-interval '7 days'))
        AND t.objective !~* '^\s*QA' AND NOT EXISTS(SELECT 1 FROM assistant.attention_brief_runs b WHERE b.task_id=t.id)
        AND NOT EXISTS(SELECT 1 FROM assistant.meeting_prep_runs p WHERE p.task_id=t.id)
        AND NOT EXISTS(SELECT 1 FROM assistant.attention_source_runs o WHERE o.task_id=t.id) AND NOT EXISTS(SELECT 1 FROM assistant.attention_source_drafts o WHERE o.task_id=t.id)
        ORDER BY t.updated_at DESC LIMIT 80`,
    sql`SELECT r.id,r.conversation_id,r.objective,r.next_review_at,r.last_evaluated_at,r.source_message_id,r.created_at,
        (SELECT n.title FROM assistant.knowledge_node_members k JOIN assistant.knowledge_nodes n ON n.workspace_id=k.workspace_id AND n.id=k.node_id
          WHERE k.workspace_id=r.workspace_id AND k.user_message_id=r.source_message_id AND k.role='owner' LIMIT 1) AS topic FROM assistant.responsibilities r
        WHERE r.workspace_id=${workspace} AND r.state='active' ORDER BY r.created_at`,
    sql`SELECT s.id,s.conversation_id,s.objective,s.due_at,s.source_message_id FROM assistant.schedules s WHERE s.workspace_id=${workspace} AND s.status='pending' ORDER BY s.due_at LIMIT 20`,
    sql`SELECT m.id,m.conversation_id,m.blocks,m.content,m.created_at FROM assistant.messages m LEFT JOIN assistant.tasks t ON t.id=m.task_id
        -- What the assistant did: two weeks for the feed's 한 일 view (a brief asks only since it last reported).
         WHERE m.workspace_id=${workspace} AND m.role='assistant' AND NOT m.hidden AND m.blocks @> '[{"kind":"result"}]' AND m.created_at>${resultSince}
         AND coalesce(t.objective,'') !~* '^\s*QA' ORDER BY m.created_at DESC LIMIT 200`,
    // Pick the latest revision before filtering summaries: "변화 없음" must suppress older changes in the series.
    sql`SELECT a.id,a.conversation_id,a.series_key,a.change_summary,a.created_at,
          (SELECT m.id FROM assistant.message_artifacts ma JOIN assistant.messages m ON m.workspace_id=ma.workspace_id AND m.id=ma.message_id
           WHERE ma.workspace_id=${workspace} AND ma.artifact_id=a.id AND NOT m.hidden ORDER BY m.created_at DESC,m.id DESC LIMIT 1) AS message_id
        FROM (SELECT DISTINCT ON (series_key) id,conversation_id,series_key,change_summary,created_at,state
              FROM assistant.artifacts WHERE workspace_id=${workspace} AND series_key IS NOT NULL AND state='ready'
              ORDER BY series_key,created_at DESC,id DESC) a
        WHERE a.state='ready' AND a.created_at>${resultSince} ORDER BY a.created_at DESC`,
  ]);
  const needs: AttentionItem[] = [], progress: AttentionItem[] = [], done: AttentionItem[] = [];
  const cardTasks = new Set<string>();
  for (const row of cards) {
    const b = MessageBlocks.catch([]).parse(row['blocks']).find(x => (x.kind === 'draft' || x.kind === 'choice') && x.id === row['block_id']);
    if (!b || (b.kind !== 'draft' && b.kind !== 'choice')) continue;
    const state = String(row['card_state']);
    if (row['card_task']) cardTasks.add(String(row['card_task']));
    const item: AttentionItem = {
      id: `card:${row['id']}:${b.id}`, kind: 'card',
      title: b.kind === 'draft' ? `${b.channel}${b.target ? ` · ${b.target}` : ''} 보낼까요?` : b.question,
      detail: b.kind === 'draft' ? firstLine(b.body) : b.options.filter(o => o.id !== 'later').map(o => o.label).join(' / '),
      at: iso(state === 'pending' || state === 'snoozed' ? row['created_at'] : row['card_updated']),
      conversation_id: String(row['conversation_id']), message_id: String(row['id']),
      // Approved but its run stopped and awaits reconciliation: say so instead of 처리 중.
      state: state === 'pending' || state === 'snoozed' ? b.kind : state === 'accepted' && row['card_task_state'] === 'unknown' ? 'accepted_stalled' : state, topic: row['topic'] ? topicLabel(String(row['topic'])) : null,
    };
    if (state === 'pending' || state === 'snoozed') needs.push(item);
    else if (state === 'accepted') progress.push(item);
    else done.push(item);
  }
  for (const t of tasks) {
    if (cardTasks.has(String(t['id']))) continue; // shown through its card
    const item: AttentionItem = { id: `task:${t['id']}`, kind: 'task', title: objectiveLine(String(t['objective'])), topic: t['topic'] ? topicLabel(String(t['topic'])) : null, detail: t['reason'] ? firstLine(String(t['reason'])) : null,
      at: iso(t['updated_at']), conversation_id: String(t['conversation_id']), message_id: t['first_message'] ? String(t['first_message']) : null, state: String(t['state']) };
    // A run that stopped is not the user's decision; it is work in trouble. Background failures recover on their own
    // schedule; a stopped foreground request stays visible as work that needs attention, not as a question for the user.
    // A reminder or routine the user set up that could not run is theirs to know about (once, by its name); the
    // assistant's own mail looks, drafts and sends recover on their own and stay out of sight.
    if (t['state'] === 'failed' || t['state'] === 'unknown') {
      if (t['lane'] !== 'background') progress.push({ ...item, state: 'stopped' });
      else if (!t['internal'] && t['origin'] !== 'user') progress.push({ ...item, title: t['task_title'] ? String(t['task_title']) : item.title, state: 'stopped' });
    }
    else progress.push(item);
  }
  for (const r of responsibilities) progress.push({ id: `responsibility:${r['id']}`, kind: 'responsibility', title: objectiveLine(String(r['objective'])), topic: r['topic'] ? topicLabel(String(r['topic'])) : null,
    detail: r['next_review_at'] ? `next:${iso(r['next_review_at'])}` : null, at: iso(r['last_evaluated_at'] ?? r['created_at']),
    conversation_id: String(r['conversation_id']), message_id: r['source_message_id'] ? String(r['source_message_id']) : null, state: 'active' });
  for (const s of schedules) progress.push({ id: `schedule:${s['id']}`, kind: 'schedule', title: firstLine(String(s['objective'])), detail: null,
    at: iso(s['due_at']), conversation_id: String(s['conversation_id']), message_id: s['source_message_id'] ? String(s['source_message_id']) : null, state: 'pending', topic: null });
  for (const row of results) for (const b of MessageBlocks.catch([]).parse(row['blocks'])) if (b.kind === 'result')
    // The headline names the channel already: the line under it is what it was about.
    done.push({ id: `result:${row['id']}`, kind: 'result', title: b.title ?? b.channel, detail: b.target, at: iso(row['created_at']), source: b.channel.replace(/\s*\(.*$/, ''), who: b.target ? b.target.replace(/\s*[<(].*$/, '').trim() : null,
      conversation_id: String(row['conversation_id']), message_id: String(row['id']), state: b.action, topic: null });
  for (const row of artifacts) {
    const summary = row['change_summary'] == null ? '' : String(row['change_summary']).trim();
    if (!summary || summary === '변화 없음') continue;
    done.push({ id: `artifact:${row['id']}`, kind: 'result', title: `결과물 · ${row['series_key']}: ${summary}`, detail: null,
      at: iso(row['created_at']), conversation_id: String(row['conversation_id']), message_id: row['message_id'] ? String(row['message_id']) : null,
      state: 'ready', topic: null });
  }
  // Watched sources: open threads that need the user, and each watch with its freshness; a broken watch needs the user only when it cannot recover on its own.
  const watched = await sourceView(sql, workspace);
  // Mail the user must act on waits for them; waiting-for-others and plain notices are watched, not their job.
  // A reply already sent or put off is no longer waiting for the user.
  const person = (v: unknown) => v ? String(v).replace(/\s*[<(].*$/, '').replace(/^"|"$/g, '').trim() || null : null;
  // An open promise is the user's until they say it is done, whatever happened to a reply about it. A reply the user is
  // waiting for from someone else becomes theirs to chase once it is late (past its date, or three days without one).
  // Late: past the date they were asked to answer by, or three days since the user asked (the asking message's time;
  // without it, since the wait was first seen). Not while a follow-up was just sent, put off, or being sent/checked.
  const late = (i: Record<string, unknown>) => {
    if (i['category'] !== 'waiting') return false;
    if (i['next_chase_at'] && new Date(String(i['next_chase_at'])) > new Date()) return false;
    if (['snoozed', 'accepted', 'checking'].includes(String(draftState(i))) || i['send_task'] === 'running' || i['send_task'] === 'checking' || i['send_task'] === 'needs_user' || i['pending_send']) return false;
    const since = new Date(String(i['waiting_since'] ?? i['first_seen_at'])).getTime();
    return i['due_at'] ? new Date(String(i['due_at'])) < new Date() : Date.now() - since > 3 * 86_400_000;
  };
  for (const i of watched.items) (i['category'] !== 'promise' && !late(i) && (i['action'] === 'none' || i['category'] === 'waiting' || ['resolved', 'accepted', 'snoozed', 'checking'].includes(String(draftState(i)))) ? progress : needs).push({ id: `mail:${i['id']}`, kind: 'mail', title: String(i['subject']), detail: [i['counterpart'], i['reason'], draftNote(draftState(i), i['preparing'])].filter(Boolean).join(' · '),
    at: iso(i['due_at'] ?? i['last_seen_at']), conversation_id: String(i['conversation_id']), message_id: i['draft_message_id'] ? String(i['draft_message_id']) : null, state: late(i) ? 'chase' : String(i['category']), action: String(i['action']), waiting_since: i['category'] === 'waiting' ? iso(i['waiting_since'] ?? i['first_seen_at']) : null, blocked: i['blocked_reason'] ? String(i['blocked_reason']) : null, topic: null, version: String(i['version']), source: i['kind'] === 'slack' ? 'Slack' : 'Gmail', who: person(i['counterpart']), url: i['url'] ? String(i['url']) : null });
  // Unconfirmed replies, from the send operation itself (independent of the thread's current version or the watch):
  // checking runs on its own; needs_user offers 다시 확인 / 보낸 게 맞아요 / 안 나갔어요 for that operation.
  for (const u of watched.unconfirmed) (u['state'] === 'needs_user' ? needs : progress).push({ id: `send:${u['send_task_id']}`, kind: 'send', title: String(u['subject']),
    detail: u['state'] === 'needs_user' ? `${u['recipient'] ? `${String(u['recipient'])}에게 보낸 ` : ''}답장이 나갔는지 확인하지 못했어요 · Gmail 보낸편지함을 봐 주세요` : '답장이 나갔는지 확인 중',
    at: iso(u['created_at']), conversation_id: String(u['conversation_id']), message_id: String(u['card_message_id']), state: String(u['state']), topic: null, version: null,
    url: u['url'] ? String(u['url']) : null, send_task_id: String(u['send_task_id']), source: 'Gmail', who: person(u['recipient']) });
  // Threads handled (by the user in Gmail/Slack, or by a reply sent from here): shown as done, with how and the evidence.
  for (const r of watched.resolved) done.push({ id: `mail:${r['id']}`, kind: 'mail', title: String(r['subject']),
    detail: [r['resolution_basis'] === 'observed_reply' && r['resolution'] === 'replied' ? `${r['kind'] === 'slack' ? 'Slack' : 'Gmail'}에서 답장함` : null, { replied: '답장 확인됨', done: '처리 완료 확인됨', withdrawn: '요청 취소됨', user_marked: '처리함으로 표시', not_needed: '답할 필요 없음' }[String(r['resolution'])] ?? '처리됨', r['resolution_note'] ? firstLine(String(r['resolution_note']), 100) : null].filter(Boolean).join(' · '),
    at: iso(r['resolved_at']), conversation_id: String(r['conversation_id']), message_id: null, state: 'handled', topic: null, version: null, url: r['url'] ? String(r['url']) : null, send_task_id: null,
    source: r['kind'] === 'slack' ? 'Slack' : 'Gmail', who: person(r['counterpart']) });
  for (const s of watched.sources) {
    const item: AttentionItem = { id: `watch:${s['id']}`, kind: 'watch', title: `${s['kind'] === 'gmail' ? 'Gmail' : s['kind'] === 'slack' ? 'Slack' : String(s['kind'])} 지켜보는 중 · ${String(s['account'])}`,
      // Honest freshness: a full check, else the last partial look, else nothing yet.
      detail: s['health'] === 'degraded' ? `degraded:${s['last_success_at'] ? iso(s['last_success_at']) : ''}` : s['last_success_at'] && (!s['last_partial_at'] || new Date(String(s['last_success_at'])) >= new Date(String(s['last_partial_at']))) ? `checked:${iso(s['last_success_at'])}`
        : s['last_partial_at'] ? `partial:${iso(s['last_partial_at'])}` : 'checked:never', at: iso(s['next_check_at']), conversation_id: String(s['conversation_id']), message_id: null,
      state: String(s['health']), topic: null, version: null, url: null, source: s['kind'] === 'slack' ? 'Slack' : 'Gmail' };
    // Only a step the user must take (login, account choice) needs them; repeated outages are shown as degraded work.
    if (s['health'] === 'needs_user') { const name = s['kind'] === 'slack' ? 'Slack' : 'Gmail'; needs.push({ ...item, title: `${name} 로그인이 필요해요`, detail: `login:VM 화면에서 ${name}에 로그인해 주세요${s['enabled'] ? '. 다음 확인부터 이어서 봐요' : '. 로그인한 뒤 다시 봐 달라고 하시면 돼요'}` }); }
    // A watch the user relies on that has not managed a full look for half a day: they should know, once, in their terms.
    else if (s['enabled'] && s['health'] === 'degraded' && (!s['last_success_at'] || Date.now() - new Date(String(s['last_success_at'])).getTime() > 12 * 3_600_000)) {
      const what = s['kind'] === 'slack' ? 'Slack' : '메일';
      needs.push({ ...item, title: `${what}을 못 챙기고 있어요`, detail: `stale:${s['last_success_at'] ? iso(s['last_success_at']) : ''}` });
    }
    else progress.push(item);
  }
  const byNewest = (a: AttentionItem, b: AttentionItem) => b.at.localeCompare(a.at);
  // What the user turned off or waved away recently: cancelled standing work and dismissed cards. Briefs must not re-offer these.
  const dismissed = await sql`SELECT objective AS text FROM assistant.responsibilities WHERE workspace_id=${workspace} AND state='cancelled' AND created_at>now()-interval '60 days'
    UNION ALL SELECT m.content FROM assistant.card_states c JOIN assistant.messages m ON m.workspace_id=c.workspace_id AND m.id=c.message_id
    WHERE c.workspace_id=${workspace} AND c.state='dismissed' AND c.updated_at>now()-interval '60 days' LIMIT 20`;
  // Today's brief: the last one delivered within 18 hours (a brief from yesterday morning is old news).
  const briefRow = (await sql`SELECT m.id,m.conversation_id,m.content,m.created_at FROM assistant.attention_briefs b JOIN assistant.messages m ON m.id=b.message_id
    WHERE b.workspace_id=${workspace} AND b.state='delivered' AND m.created_at>now()-interval '18 hours' ORDER BY m.created_at DESC LIMIT 1`)[0];
  const brief = briefRow ? { body: String(briefRow['content']), at: iso(briefRow['created_at']), conversation_id: String(briefRow['conversation_id']), message_id: String(briefRow['id']) } : null;
  // What needs the user, most urgent first: past due, then someone waiting for an answer (newest first), then the
  // nearest due date, then the rest. A far-off due date does not push a fresh request off the top.
  const now = Date.now();
  const rank = (i: AttentionItem) => {
    const t = Date.parse(i.at);
    if (i.state === 'overdue' || (i.kind === 'mail' && (i.state === 'deadline' || i.state === 'promise') && t < now)) return 0;
    if (i.kind === 'card' || i.kind === 'send' || (i.kind === 'mail' && (i.state === 'request' || i.state === 'waiting' || i.state === 'chase'))) return 1;
    if (i.kind === 'mail' && t > now && t - now < 2 * 86_400_000) return 2;
    return 3;
  };
  // Within a rank: dates ahead nearest first, everything else newest first.
  const ahead = (i: AttentionItem) => Date.parse(i.at) > now;
  const urgent = (a: AttentionItem, b: AttentionItem) => rank(a) - rank(b) || (ahead(a) && ahead(b) ? a.at.localeCompare(b.at) : b.at.localeCompare(a.at));
  return Attention.parse({ brief, needs_you: needs.sort(urgent), in_progress: progress, done: done.sort(byNewest).slice(0, 120), dismissed_offers: dismissed.map(r => firstLine(String(r['text']), 100)) });
}
