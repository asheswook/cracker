/**
 * Watched sources (first: Gmail via the VM browser). The user asks once ("Gmail 챙겨줘"), or asks for a single look;
 * code decides when to look, a background run reads with the source's skill and reports a structured observation,
 * and code keeps one item per thread until there is evidence it was handled.
 *
 * Publication right: a run carries the source revision it was started under. Turning the watch off (or on again)
 * bumps the revision and withdraws open runs, so a late report changes nothing. Runs expire; an expired queued task
 * is cancelled, and a late report is refused.
 *
 * Coverage: the window start of an incomplete look is fixed until it is fully read; a partial look records the oldest
 * time it read, and the next look continues from there (backfill) instead of starting over.
 *
 * A thread that needs the user's reply gets one reply draft, prepared by a separate run that re-reads the thread;
 * when a later look sees the user replied in Gmail, the item resolves and the unsent draft is closed.
 */
import { z } from 'zod';
import type { Database, Query } from '../../services/control/db';
import { createBackgroundTask } from '../../services/control/repository/common';
import { bindSkill } from '../extensions/versions';

export const ObservationItem = z.object({
  thread_key: z.string().trim().min(1).max(200),
  url: z.string().url().max(2000).nullable(),
  subject: z.string().trim().min(1).max(300),
  counterpart: z.string().trim().max(200).nullable(),
  /** request: asked of the user. deadline: a date ahead. overdue: a date passed without it being done. waiting: the user asked and the reply is late. alert: cost/security/expiry. promise: the user promised something by a date in their own reply. */
  category: z.enum(['request', 'deadline', 'overdue', 'waiting', 'alert', 'promise']),
  /** What the user has to do: reply, review (e.g. code review), act (do something elsewhere), none (just know). */
  action: z.enum(['reply', 'review', 'act', 'none']),
  reason: z.string().trim().min(1).max(400),
  /** A short quote from the thread that shows the request (who asked what). */
  evidence: z.string().trim().max(400).nullable(),
  due_at: z.iso.datetime({ offset: true }).nullable(),
  version: z.string().trim().min(1).max(120),
  /** The incoming message that asks (sender + time from source_gmail_thread), e.g. "alex@example.com|2026년 1월 5일 오전 7:13". */
  request_anchor: z.string().trim().max(200).nullable().default(null),
  /** For category=waiting: when the user asked (the asking message's time), ISO. */
  waiting_since: z.iso.datetime({ offset: true }).nullable().default(null),
}).strict();
export const Resolution = z.object({
  thread_key: z.string().trim().min(1).max(200),
  /** replied: the user (or someone on their behalf) answered in the thread. done: the requester confirmed it is done. withdrawn: the requester cancelled it. */
  how: z.enum(['replied', 'done', 'withdrawn']),
  evidence: z.string().trim().min(1).max(400),
  /** The later message that answered it (sender + time), when how=replied. */
  answered_by: z.string().trim().max(200).nullable().default(null),
}).strict();
export const Observation = z.object({
  account: z.string().trim().min(3).max(200),
  coverage: z.enum(['complete', 'partial', 'failed']),
  error_kind: z.enum(['login_required', 'account_choice', 'browser_unavailable', 'ui_changed', 'other']).nullable(),
  error: z.string().max(400).nullable(),
  /** For partial: the oldest message time that was fully read (the next look continues before it). */
  oldest_read: z.iso.datetime({ offset: true }).nullable().default(null),
  items: z.array(ObservationItem).max(60),
  resolved: z.array(Resolution).max(100),
}).strict().superRefine((o, ctx) => {
  if (o.coverage === 'failed' && (o.items.length || o.resolved.length)) ctx.addIssue({ code: 'custom', message: 'a failed look reports no items and resolves nothing' });
  const open = new Set(o.items.map(i => i.thread_key));
  if (o.resolved.some(r => open.has(r.thread_key))) ctx.addIssue({ code: 'custom', message: 'a thread cannot be open and resolved at once' });
});
export type Observation = z.infer<typeof Observation>;

const OBSERVE_TTL_MINUTES = 40;
type Kind = 'gmail' | 'slack';
/** What differs between sources: names, the skill to read with, what a thread is, and how a reply is sent. */
const SOURCE = {
  gmail: { name: 'Gmail', skill: '%gmail%', thread: 'Gmail thread id', version: 'last message time + message count', unit: '메일',
    read: "Read with source_gmail_list (all folders but spam/trash, a date window after/before as YYYY/MM/DD, every page) and source_gmail_thread (one thread by id, per message). These are the only tools; use the Gmail skill only for what to look for, not its scripts. Read state means nothing. If source_gmail_list returns complete=false or an error, your coverage is partial or failed, never complete.",
    reread: 'Read the thread with source_gmail_thread (by its thread id) yourself.',
    send: 'Open that thread and send as a reply in it (not a new mail).' },
  slack: { name: 'Slack', skill: '%slack%', thread: '"<channel id>:<thread ts or message ts>"', version: 'latest reply ts + reply count', unit: 'Slack 대화',
    read: "Read with source_slack_read (workspace = the account given; auth.test, users.conversations, conversations.history, conversations.replies, users.info); it is the only tool. Use the Slack skill only for what to look for, not its scripts. Read state means nothing.",
    reread: 'Read that conversation and thread with source_slack_read (conversations.replies) yourself.',
    send: 'Open that conversation and post in the same thread (reply in thread, not a new top-level message unless it was a DM without a thread).' },
} as const satisfies Record<Kind, Record<string, string>>;
const FIRST_LOOK_DAYS = 3;

export function observeObjective(source: { kind?: Kind; account: string; window_start: Date; backfill_before: Date | null; read_through: Date | null; as_of: Date; recheck: readonly { thread_key: string; subject: string }[]; once: boolean }) {
  return [
    `${SOURCE[source.kind ?? 'gmail'].name} observation for ${source.account} (${source.once ? 'a single look the user asked for' : 'assistant-owned watch the user asked for'}). ${SOURCE[source.kind ?? 'gmail'].read}`,
    "The scheduler already chose this time: ignore the skill's own night-hours, dedup and reporting/notify rules; this run reports only through report_observation.",
    `Read threads with activity since ${source.window_start.toISOString()} (overlap is fine; widen the script's day range and row count as needed).`,
    source.backfill_before && source.read_through ? `An earlier partial look already read ${source.backfill_before.toISOString()} – ${source.read_through.toISOString()}; you may skip that span.` : '',
    'First confirm the signed-in account (or workspace) matches; if not, report coverage=failed, error_kind=other.',
    source.recheck.length ? `Re-check these open threads (open each) and report each either again in items (if still needing the user) or in resolved with evidence: ${source.recheck.map(o => `${o.thread_key} (${o.subject.slice(0, 60)})`).join('; ')}.` : '',
    'For each item set request_anchor = the asking message as "<sender address>|<time>" from source_gmail_thread (for a promise: the user\'s own promising message). A promise is resolved only when the promised thing was sent or done, never by a reply alone. Resolved (how=replied) only when a message from the account comes after that request and no newer request from the other side is unanswered; set answered_by = that reply as "<address>|<time>". A thank-you or acknowledgement after a reply is not a new request. A passed deadline is overdue, not resolved. Being read, archived or missing from a search is not evidence.',
    'Mark action=reply only when someone asked the user directly and expects an answer from them; general notices and announcements are action=none or act. When the open item is something the user promised in their own reply (e.g. "금요일까지 보내 드리겠습니다"), use category=promise, action=act, due_at = that date, and reason = what was promised. When the user asked someone for something and the answer has not come, use category=waiting, action=none, due_at = the date they were asked to answer by (or null), reason = what is awaited; request_anchor = the user\'s asking message; waiting_since = that message\'s time (ISO).',
    `thread_key = ${SOURCE[source.kind ?? 'gmail'].thread}; version = ${SOURCE[source.kind ?? 'gmail'].version}. Write reason (and evidence) as one short Korean sentence the user can read at a glance (under 60 characters, no UTC: times in KST like \"10/30(금) 오후 3시\"). Call report_observation exactly once; if you could not read the whole range set coverage=partial and oldest_read. If login or an account choice is needed, coverage=failed with that error_kind. Never call notify_user or ask_user. Then reply exactly NO_REPORT.`,
  ].filter(Boolean).join(' ');
}

async function quietWait(tx: Query, workspace: string, now: Date) {
  const quiet = (await tx`SELECT quiet_start_minute AS qs,quiet_end_minute AS qe,timezone FROM assistant.attention_settings WHERE workspace_id=${workspace}`)[0];
  if (!quiet) return 0;
  const [h, m] = new Intl.DateTimeFormat('en-GB', { timeZone: String(quiet['timezone']), hour: '2-digit', minute: '2-digit', hourCycle: 'h23' }).format(now).split(':').map(Number);
  const minute = (h ?? 0) * 60 + (m ?? 0), qs = Number(quiet['qs']), qe = Number(quiet['qe']);
  const inside = qs === qe ? false : qs > qe ? minute >= qs || minute < qe : minute >= qs && minute < qe;
  return inside ? ((qe - minute + 1440) % 1440) + 5 : 0;
}

/** Start one look at a source (scheduled or once). Call with the source row locked. */
async function startLook(tx: Query, s: Record<string, unknown>, now: Date, once: false | { conversation: string; message: string }) {
  const id = String(s['id']);
  const covered = s['covered_through'] ? new Date(String(s['covered_through'])) : null;
  const pending = s['pending_window_start'] ? new Date(String(s['pending_window_start'])) : null;
  const windowStart = pending ?? (covered ? new Date(covered.getTime() - 30 * 60_000) : new Date(now.getTime() - FIRST_LOOK_DAYS * 86_400_000));
  const backfill = s['backfill_before'] ? new Date(String(s['backfill_before'])) : null;
  // Open threads, least recently checked first, so none is starved.
  const recheck = (await tx`SELECT thread_key,subject FROM assistant.attention_source_items WHERE source_id=${id} AND state='open' ORDER BY last_checked_at NULLS FIRST,last_seen_at LIMIT 12`)
    .map(r => ({ thread_key: String(r['thread_key']), subject: String(r['subject']) }));
  const lastPartial = backfill ? (await tx`SELECT as_of FROM assistant.attention_source_runs WHERE source_id=${id} AND state='partial' ORDER BY created_at DESC LIMIT 1`)[0] : undefined;
  const readThrough = lastPartial ? new Date(String(lastPartial['as_of'])) : null;
  const objective = observeObjective({ kind: s['kind'] as Kind, account: String(s['account']), window_start: windowStart, backfill_before: backfill, read_through: readThrough, as_of: now, recheck, once: !!once });
  const conversation = once ? once.conversation : String(s['conversation_id']);
  const created = await createBackgroundTask(tx, { workspace: String(s['workspace_id']), conversation, objective, title: `${s['kind'] === 'slack' ? 'Slack 확인' : '메일 확인'} · ${String(s['account'])}`.slice(0, 60), origin: 'responsibility', clientId: crypto.randomUUID() });
  if (s['skill_id'] && s['skill_revision']) await bindSkill(tx, { workspace: String(s['workspace_id']), task: created.task.id, message: created.message.id, skill: String(s['skill_id']), revision: Number(s['skill_revision']), kind: 'scheduled' });
  await tx`INSERT INTO assistant.attention_source_runs(source_id,workspace_id,task_id,window_start,as_of,source_revision,expires_at,once,recheck_keys,conversation_id,request_message_id)
    VALUES(${id},${String(s['workspace_id'])},${created.task.id},${windowStart},${now},${Number(s['revision'])},${now}::timestamptz+${OBSERVE_TTL_MINUTES}*interval '1 minute',${!!once},${tx.array(recheck.map(r => r.thread_key))},
      ${conversation},${once ? once.message : null})`;
  await tx`UPDATE assistant.attention_sources SET pending_window_start=${windowStart},last_attempt_at=${now},updated_at=now() WHERE id=${id}`;
  return created.task.id;
}

/** Close the unsent draft cards of an item. how: superseded (handled elsewhere) or replaced (the thread changed). */
async function closeDrafts(tx: Query, workspace: string, item: string, how: 'superseded' | 'replaced') {
  await tx`UPDATE assistant.card_states c SET state=${how},updated_at=now() FROM assistant.attention_source_drafts d
    WHERE d.item_id=${item} AND d.card_message_id=c.message_id AND c.workspace_id=${workspace} AND (c.state IN ('pending','snoozed') OR c.state='failed' AND c.retry_ok)`;
  await tx`UPDATE assistant.card_states c SET retry_ok=false FROM assistant.attention_source_drafts d
    WHERE d.item_id=${item} AND d.card_message_id=c.message_id AND c.workspace_id=${workspace} AND c.retry_ok`;
  // Their draft jobs are done with too, so a new draft can be written when one is needed.
  await tx`UPDATE assistant.attention_source_drafts d SET state='withdrawn',finished_at=coalesce(d.finished_at,now()) FROM assistant.card_states c
    WHERE d.item_id=${item} AND d.state='ready' AND c.workspace_id=${workspace} AND c.message_id=d.card_message_id AND c.state IN (${how},'replaced')`;
}
async function withdrawDrafts(tx: Query, source: string) {
  const rows = await tx`UPDATE assistant.attention_source_drafts SET state='withdrawn',finished_at=now() WHERE source_id=${source} AND state='dispatched' RETURNING task_id`;
  for (const r of rows) await tx`UPDATE assistant.tasks SET state='cancelled',reason='Watch changed',updated_at=now() WHERE id=${r['task_id']} AND state='queued'`;
}
async function withdrawRuns(tx: Query, where: { source?: string; expiredBefore?: Date }, state: 'expired' | 'withdrawn') {
  const rows = where.source
    ? await tx`UPDATE assistant.attention_source_runs SET state=${state},finished_at=now() WHERE source_id=${where.source} AND state='dispatched' RETURNING task_id,source_id`
    : await tx`UPDATE assistant.attention_source_runs SET state=${state},finished_at=now() WHERE state='dispatched' AND expires_at<=${where.expiredBefore ?? new Date()} RETURNING task_id,source_id`;
  for (const r of rows) await tx`UPDATE assistant.tasks SET state='cancelled',reason=${state === 'expired' ? 'Observation expired before it ran' : 'Watch changed'},updated_at=now() WHERE id=${r['task_id']} AND state='queued'`;
  return rows;
}

/** Code-owned schedule: expire stuck runs (a timeout is a failure with backoff), dispatch due sources, one look at a time. */
export async function tickSources(sql: Database, now = new Date()) {
  await sql.begin(async tx => {
    const expired = await withdrawRuns(tx, { expiredBefore: now }, 'expired');
    for (const r of expired) {
      await noteFailure(tx, String(r['source_id']), 'browser_unavailable', 'observation timed out');
      // A single look always answers the one who asked, also when it never ran.
      const run = (await tx`SELECT r.*,s.account,s.kind FROM assistant.attention_source_runs r JOIN assistant.attention_sources s ON s.id=r.source_id WHERE r.task_id=${r['task_id']}`)[0];
      if (run && (run['once'] || (run['also_answer'] as string[] | null)?.length)) await answerOnce(tx, String(run['workspace_id']), run, { coverage: 'failed', error_kind: 'browser_unavailable', items: [] });
    }
    // A draft job that never finished does not hold its thread forever: it expires and may be tried again.
    const stale = await tx`UPDATE assistant.attention_source_drafts SET state='expired',finished_at=${now} WHERE state='dispatched' AND expires_at<=${now} RETURNING task_id`;
    for (const d of stale) await tx`UPDATE assistant.tasks SET state='cancelled',reason='Reply draft expired before it ran',updated_at=now() WHERE id=${d['task_id']} AND state='queued'`;
  });
  const due = (await sql`SELECT id FROM assistant.attention_sources WHERE enabled AND next_check_at<=${now}`).map(r => String(r['id']));
  let dispatched = 0;
  for (const id of due) {
    try {
      dispatched += await sql.begin(async tx => {
        const s = (await tx`SELECT * FROM assistant.attention_sources WHERE id=${id} AND enabled AND next_check_at<=${now} FOR UPDATE SKIP LOCKED`)[0];
        if (!s) return 0;
        if ((await tx`SELECT 1 FROM assistant.attention_source_runs WHERE source_id=${id} AND state='dispatched'`)[0]) return 0;
        const wait = await quietWait(tx, String(s['workspace_id']), now);
        if (wait) { await tx`UPDATE assistant.attention_sources SET next_check_at=${now}::timestamptz+${wait}*interval '1 minute' WHERE id=${id}`; return 0; }
        await startLook(tx, s, now, false);
        await tx`UPDATE assistant.attention_sources SET next_check_at=${now}::timestamptz+interval_minutes*interval '1 minute' WHERE id=${id}`;
        return 1;
      });
    } catch (error) {
      if (!(error instanceof Error)) throw error;
      console.error(JSON.stringify({ event: 'attention.source_failed', source: id, type: error.name, message: error.message.slice(0, 200) }));
    }
  }
  await dispatchReplyDrafts(sql, now);
  return dispatched;
}

/** Failures retry with backoff; only a step the user must take (login, account choice) needs them. */
async function noteFailure(tx: Query, source: string, kind: string | null, error: string | null) {
  const userStep = kind === 'login_required' || kind === 'account_choice';
  await tx`UPDATE assistant.attention_sources SET failure_count=failure_count+1,
    health=CASE WHEN ${userStep} THEN 'needs_user' WHEN failure_count+1>=3 THEN 'degraded' ELSE 'retrying' END,
    last_error=${error ?? kind},updated_at=now() WHERE id=${source}`;
  await tx`UPDATE assistant.attention_sources SET next_check_at=now()+LEAST(240,15*power(2,LEAST(failure_count-1,5)))*interval '1 minute' WHERE id=${source} AND enabled`;
}

/** The observation run reports what it saw. Accepted once, only from a live run of the current revision. */
export async function recordObservation(sql: Query, workspace: string, task: string, input: unknown) {
  const run = (await sql`SELECT r.*,s.account,s.kind,s.revision,s.enabled FROM assistant.attention_source_runs r JOIN assistant.attention_sources s ON s.id=r.source_id
    WHERE r.workspace_id=${workspace} AND r.task_id=${task} FOR UPDATE OF r,s`)[0];
  if (!run) return { recorded: false, reason: 'not an observation run' };
  if (run['state'] !== 'dispatched') return { recorded: false, reason: `run already ${run['state']}` };
  const live = Number(run['source_revision']) === Number(run['revision']) && (run['enabled'] || run['once']) && new Date(String(run['expires_at'])) > new Date();
  if (!live) {
    const expired = new Date(String(run['expires_at'])) <= new Date();
    await sql`UPDATE assistant.attention_source_runs SET state=${expired ? 'expired' : 'withdrawn'},finished_at=now() WHERE task_id=${task}`;
    // Expired before cron noticed: the asker still gets an answer (the late result is not used).
    if (expired && (run['once'] || (run['also_answer'] as string[] | null)?.length)) await answerOnce(sql, workspace, run, { coverage: 'failed', error_kind: 'browser_unavailable', items: [] });
    return { recorded: false, reason: 'this look was withdrawn or expired; nothing recorded' };
  }
  const parsed = Observation.safeParse(input);
  if (!parsed.success) return { recorded: false, reason: parsed.error.issues.map(i => i.message).join('; '), retry: 'fix and call report_observation again' };
  let observation = parsed.data;
  const source = String(run['source_id']), asOf = new Date(String(run['as_of']));
  if (observation.account.toLowerCase() !== String(run['account']).toLowerCase())
    observation = { ...observation, coverage: 'failed', error_kind: 'other', error: `signed in as ${observation.account}, expected ${String(run['account'])}`, items: [], resolved: [] };
  // Complete only if the adapter itself read the whole needed range (code-recorded coverage, not the model's report).
  if (observation.coverage === 'complete' && !coverageComplete(run)) observation = { ...observation, coverage: 'partial', oldest_read: null };
  // A complete look must account for every thread it was asked to re-check; otherwise it is partial.
  if (observation.coverage === 'complete') {
    const answered = new Set([...observation.items.map(i => i.thread_key), ...observation.resolved.map(r => r.thread_key)]);
    const missing = (run['recheck_keys'] as string[] | null ?? []).filter(k => !answered.has(k));
    // The search window was read, but some open threads were not re-checked: the window may advance, they stay first in line.
    if (missing.length) observation = { ...observation, coverage: 'partial', oldest_read: null };
  }
  const onceUntil = run['once'] ? new Date(Date.now() + 6 * 3_600_000) : null;
  for (const item of observation.items) {
    const before = (await sql`SELECT * FROM assistant.attention_source_items WHERE source_id=${source} AND thread_key=${item.thread_key} FOR UPDATE`)[0];
    const next = mergeObligation(before ?? null, item);
    // The thread changed (or no longer needs a reply): an unsent draft written for the old version must not go out.
    // A follow-up or a delivery for the same obligation stays while the thread is unchanged.
    if (before && (before['version'] !== item.version || (next.action !== 'reply' && next.category !== 'promise' && next.category !== 'waiting'))) await closeDrafts(sql, workspace, String(before['id']), 'replaced');
    await sql`INSERT INTO assistant.attention_source_items(source_id,workspace_id,thread_key,url,subject,counterpart,category,action,reason,evidence,due_at,version,last_checked_at,request_anchor,waiting_since)
      VALUES(${source},${workspace},${item.thread_key},${item.url},${item.subject},${item.counterpart},${next.category},${next.action},${next.reason},${next.evidence},${next.due_at},${item.version},now(),${next.request_anchor},${item.category === 'waiting' ? item.waiting_since : null})
      ON CONFLICT (source_id,thread_key) DO UPDATE SET url=excluded.url,subject=excluded.subject,counterpart=excluded.counterpart,
        category=excluded.category,action=excluded.action,reason=excluded.reason,evidence=excluded.evidence,due_at=excluded.due_at,request_anchor=excluded.request_anchor,
        state=${next.state},resolved_at=${next.keepResolved ? sql`attention_source_items.resolved_at` : sql`NULL`},
        user_due_at=${next.same ? sql`attention_source_items.user_due_at` : sql`NULL`},
        blocked_reason=${next.same ? sql`attention_source_items.blocked_reason` : sql`NULL`},blocked_at=${next.same ? sql`attention_source_items.blocked_at` : sql`NULL`},
        reply_note=${next.same ? sql`attention_source_items.reply_note` : sql`NULL`},reply_request_id=${next.same ? sql`attention_source_items.reply_request_id` : sql`NULL`},
        reply_keep_body=${next.same ? sql`attention_source_items.reply_keep_body` : sql`NULL`},
        waiting_since=${next.category === 'waiting' ? (next.same ? sql`coalesce(attention_source_items.waiting_since,${item.waiting_since}::timestamptz)` : sql`${item.waiting_since}::timestamptz`) : sql`NULL`},
        next_chase_at=${next.same && next.category === 'waiting' ? sql`attention_source_items.next_chase_at` : sql`NULL`},
        last_seen_at=now(),last_checked_at=now(),version=excluded.version,updated_at=now()`;
    await sql`UPDATE assistant.attention_source_items SET conversation_id=${run['conversation_id'] ? String(run['conversation_id']) : null}::uuid${onceUntil ? sql`,once_until=${onceUntil}` : sql``} WHERE source_id=${source} AND thread_key=${item.thread_key}`;
    // The thread as the adapter read it during this look (the model's report is never stored as the thread).
    const snap = (run['thread_snapshots'] as Record<string, unknown> | null)?.[item.thread_key];
    if (snap) await sql`UPDATE assistant.attention_source_items SET thread_snapshot=${JSON.stringify(snap)}::text::jsonb,thread_read_at=now() WHERE source_id=${source} AND thread_key=${item.thread_key}`;
  }
  for (const r of observation.resolved) {
    const current = (await sql`SELECT category,waiting_since,request_anchor FROM assistant.attention_source_items WHERE source_id=${source} AND thread_key=${r.thread_key} AND state='open' FOR UPDATE`)[0];
    const rows = await sql`UPDATE assistant.attention_source_items SET state='resolved',resolution=${r.how},resolution_note=${r.evidence},handled_evidence=${r.answered_by},resolution_basis='observed_reply',resolved_at=now(),last_checked_at=now(),updated_at=now()
      -- A reply does not do what the user promised: a promise closes only when the promised thing was done (how=done).
      -- A wait closes only on the other side's answer this look actually read (checked below), never on the user's own mail.
      WHERE source_id=${source} AND state='open' AND thread_key=${r.thread_key} AND (category<>'promise' OR ${r.how}='done')
        AND (category<>'waiting' OR ${waitAnswered(run, r, current)}) RETURNING id`;
    for (const row of rows) await withdrawAlertsFor(sql, workspace, String(row['id']));
    // The reply happened in Gmail: an unsent draft for it must not be sendable any more.
    for (const row of rows) await closeDrafts(sql, workspace, String(row['id']), 'superseded');
  }
  await sql`UPDATE assistant.attention_source_runs SET state=${observation.coverage},error_kind=${observation.error_kind},items_seen=${observation.items.length},oldest_read=${observation.oldest_read},finished_at=now() WHERE task_id=${task}`;
  if (observation.coverage === 'failed') await noteFailure(sql, source, observation.error_kind, observation.error);
  else if (observation.coverage === 'complete')
    await sql`UPDATE assistant.attention_sources SET failure_count=0,health='ok',last_error=NULL,last_success_at=now(),covered_through=${asOf},
      pending_window_start=NULL,backfill_before=NULL,updated_at=now() WHERE id=${source}`;
  else {
    // Partial: keep the fixed window start, continue before the oldest fully read time, and look again soon.
    const oldest = observation.oldest_read ? new Date(observation.oldest_read) : null;
    await sql`UPDATE assistant.attention_sources SET health=CASE WHEN health='needs_user' THEN 'ok' ELSE health END,
      backfill_before=${oldest && oldest > new Date(String(run['window_start'])) ? oldest : null},
      next_check_at=CASE WHEN enabled THEN LEAST(next_check_at,now()+interval '20 minutes') ELSE next_check_at END,updated_at=now() WHERE id=${source}`;
  }
  // A single look answers its asker; a scheduled look answers requests that joined it.
  if (run['once'] || (run['also_answer'] as string[] | null)?.length) await answerOnce(sql, workspace, run, observation);
  return { recorded: true, coverage: observation.coverage, items: observation.items.length, resolved: observation.resolved.length };
}

/** A single look answers the conversation that asked, whatever happened: found, nothing, partial, or could not look. */
async function answerOnce(sql: Query, workspace: string, run: Record<string, unknown>, o: Pick<Observation, 'coverage' | 'error_kind' | 'items'>) {
  const targets = [...new Set([run['once'] ? run['conversation_id'] : null, ...((run['also_answer'] as string[] | null) ?? [])].filter(Boolean).map(String))];
  for (const conversation of targets) await answerOnceIn(sql, workspace, run, o, conversation, conversation === String(run['conversation_id']));
}
async function answerOnceIn(sql: Query, workspace: string, run: Record<string, unknown>, o: Pick<Observation, 'coverage' | 'error_kind' | 'items'>, conversation: string, asker: boolean) {
  const reply = o.items.filter(i => i.action === 'reply').length, act = o.items.filter(i => i.action === 'review' || i.action === 'act').length;
  const unit = SOURCE[(run['kind'] as Kind | undefined) ?? 'gmail'].unit;
  const found = [reply ? `직접 답할 ${unit} ${reply}건(답장 초안을 준비하고 있어요)` : '', act ? `확인·처리할 ${unit} ${act}건` : ''].filter(Boolean).join(', ');
  // The answer names what was found, by what the user has to do; details and the originals live in 피드.
  const order = ['reply', 'review', 'act', 'none'] as const, head = { reply: '답장', review: '검토', act: '처리', none: '참고' } as const;
  const lines = order.flatMap(a => o.items.filter(i => i.action === a).slice(0, 6).map(i => `- **${head[a]}** · ${i.subject}${i.counterpart ? ` (${i.counterpart})` : ''}: ${i.reason}`));
  const src = SOURCE[(run['kind'] as Kind | undefined) ?? 'gmail'], what = `${String(run['account'])} ${src.unit}`;
  // 을/를 by the last syllable's final consonant (메일을, 대화를).
  const code = src.unit.charCodeAt(src.unit.length - 1) - 0xac00, obj = code >= 0 && code < 11172 && code % 28 ? '을' : '를';
  const text = o.coverage === 'failed'
    ? (o.error_kind === 'login_required' || o.error_kind === 'account_choice' ? `${what}${obj} 확인하지 못했어요. VM 화면에서 ${src.name} 로그인이 필요해요. 로그인한 뒤 다시 봐 달라고 하시면 이어서 볼게요.` : `${what}${obj} 확인하지 못했어요. 브라우저 연결이 불안정했어요. 다시 해 달라고 하시면 한 번 더 볼게요.`)
    : `${what}${obj} ${o.coverage === 'partial' ? '일부만' : '한 번'} 확인했어요. ${found ? `${found}이 피드에 있어요.` : `직접 답하거나 처리할 ${src.unit}${src.unit === '메일' ? '은' : '는'} 없었어요.`}${o.coverage === 'partial' ? ` 전체를 다 보지는 못해서, 빠진 ${src.unit}${src.unit === '메일' ? '이' : '가'} 있을 수 있어요.` : ''} 상시 점검은 켜지 않았어요.${lines.length ? `\n\n${lines.join('\n')}` : ''}`;
  const task = String(run['task_id']);
  const message = (await sql`INSERT INTO assistant.messages(workspace_id,conversation_id,task_id,role,content,origin,phase,response_to_message_id) VALUES(${workspace},${conversation},${asker ? task : null},'assistant',${text},'responsibility','final_answer',${asker && run['request_message_id'] ? String(run['request_message_id']) : null}) RETURNING id`)[0];
  await sql`WITH e AS (INSERT INTO assistant.events(workspace_id,kind,payload) VALUES(${workspace},'message.created',${JSON.stringify({ message: { id: message?.['id'] } })}::text::jsonb) RETURNING id) INSERT INTO assistant.outbox(workspace_id,event_id) SELECT ${workspace},id FROM e`;
}

/** The observation run ended without reporting: a failure (never "no new mail"). */
export async function settleObservationTask(sql: Query, workspace: string, task: string, state: string) {
  if (!['succeeded', 'failed', 'cancelled'].includes(state)) return;
  const rows = await sql`UPDATE assistant.attention_source_runs r SET state='failed',error_kind='no_report',finished_at=now() FROM assistant.attention_sources s
    WHERE s.id=r.source_id AND r.workspace_id=${workspace} AND r.task_id=${task} AND r.state='dispatched' RETURNING r.*,s.account,s.kind`;
  for (const r of rows) {
    if (state !== 'cancelled') await noteFailure(sql, String(r['source_id']), 'other', 'observation ended without a report');
    if ((r['once'] || (r['also_answer'] as string[] | null)?.length) && state !== 'cancelled') await answerOnce(sql, workspace, r, { coverage: 'failed', error_kind: 'other', items: [] });
  }
  // A draft job that ended without a card failed; the item may try again later (bounded).
  await sql`UPDATE assistant.attention_source_drafts SET state='failed',note=${`ended ${state}`},finished_at=now() WHERE workspace_id=${workspace} AND task_id=${task} AND state='dispatched'`;
}

/** A reply-draft run, for its whole life: its cards wait in 피드 and the brief, it never pushes or notifies. */
export async function isReplyDraftTask(sql: Query, workspace: string, task: string) {
  return !!(await sql`SELECT 1 FROM assistant.attention_source_drafts WHERE workspace_id=${workspace} AND task_id=${task}`)[0];
}
/** Looks and reply-draft jobs read; they never write outside. The daemon enforces it from the assignment's run_policy. */
export async function readOnlyTask(sql: Query, workspace: string, task: string) {
  return await isObservationTask(sql, workspace, task) || await isReplyDraftTask(sql, workspace, task);
}
/** The policy a source job runs under (enforced by the daemon): looks and drafts read; a send job sends one approved reply. */
export async function sourceRunPolicy(sql: Query, workspace: string, task: string): Promise<'read_only' | 'send_once' | null> {
  if (await readOnlyTask(sql, workspace, task)) return 'read_only';
  if (await sendJobKind(sql, workspace, task)) return 'send_once';
  return null;
}
type Coverage = { kind?: 'gmail' | 'slack_channels' | 'slack_history' | undefined; account?: string | undefined; after?: string | undefined; before?: string | null | undefined; channel?: string | undefined; oldest?: number | undefined; team?: string | undefined; cursor?: string | undefined; next_cursor?: string | undefined; channels?: string[] | undefined; utc_offset_minutes?: number | undefined; complete: boolean; rows: number };
/** A Gmail search day as an instant: midnight in the zone the browser searched in (UTC when not reported). */
const searchDay = (d: string, offsetMinutes = 0) => new Date(new Date(`${d.replace(/\//g, '-')}T00:00:00Z`).getTime() - offsetMinutes * 60_000);
/**
 * Did the adapter read everything this look needed? Gmail: a complete search of this account from at or before the
 * window start to at or after the look time. Slack: the full channel list, and every channel's history read to the end
 * from at or before the window start.
 */
function coverageComplete(run: Record<string, unknown>) {
  const covered = (run['adapter_coverage'] as Coverage[] | null) ?? [];
  const start = run['window_start'] ? new Date(String(run['window_start'])) : null, asOf = new Date(String(run['as_of']));
  if (!start) return false;
  if (run['kind'] === 'slack') {
    // One team; the channel list read to its end (pages joined); every listed channel's history read to the end
    // from at or before the window start (a channel is done when any of its calls reached the end).
    const lists = covered.filter(c => c.kind === 'slack_channels');
    // Every record from one team (records without a team do not count), and the channel list read from its first page
    // (no cursor) through to a last page (complete), each later page asked with a cursor a previous page returned.
    if (covered.some(c => !c.team)) return false;
    const teams = new Set(covered.map(c => c.team));
    if (teams.size !== 1 || !lists.some(c => !c.cursor) || !lists.some(c => c.complete)) return false;
    const cursors = new Set(lists.map(c => c.next_cursor).filter(Boolean));
    if (lists.some(c => c.cursor && !cursors.has(c.cursor))) return false;
    const channels = new Set(lists.flatMap(c => c.channels ?? []));
    const done = new Set(covered.filter(c => c.kind === 'slack_history' && c.complete && (c.oldest ?? Infinity) * 1000 <= start.getTime()).map(c => c.channel));
    return channels.size > 0 && [...channels].every(id => done.has(id));
  }
  // Gmail: complete windows of this account, joined, must span [window start, look time].
  const spans = covered.filter(c => (c.kind ?? 'gmail') === 'gmail' && c.complete && c.after && c.account?.toLowerCase() === String(run['account']).toLowerCase())
    .map(c => [searchDay(c.after!, c.utc_offset_minutes).getTime(), c.before ? searchDay(c.before, c.utc_offset_minutes).getTime() : Infinity] as const).sort((a, b) => a[0] - b[0]);
  let reach = start.getTime();
  for (const [from, to] of spans) { if (from > reach) break; reach = Math.max(reach, to); }
  return spans.length > 0 && spans[0]![0] <= start.getTime() && reach > asOf.getTime();
}
/** The daemon records each list call's coverage for the running look (the model cannot widen it). */
export async function noteAdapterCoverage(sql: Query, workspace: string, task: string, coverage: Coverage) {
  await sql`UPDATE assistant.attention_source_runs SET adapter_coverage=adapter_coverage||${JSON.stringify([coverage])}::text::jsonb WHERE workspace_id=${workspace} AND task_id=${task} AND state='dispatched'`;
}
export async function isObservationTask(sql: Query, workspace: string, task: string) {
  return !!(await sql`SELECT 1 FROM assistant.attention_source_runs WHERE workspace_id=${workspace} AND task_id=${task}`)[0];
}

/** Enrollment: only from the user's own words. once=true is a single look that does not turn the watch on. */
export const WatchRequest = z.object({
  kind: z.enum(['gmail', 'slack']), account: z.string().trim().min(3).max(200),
  mode: z.enum(['watch', 'stop', 'once']), source_quote: z.string().trim().min(2).max(300), interval_minutes: z.number().int().min(30).max(1440).nullable(),
}).strict();
export async function setWatch(sql: Query, input: { workspace: string; conversation: string; source_message: string } & z.infer<typeof WatchRequest>) {
  const skill = (await sql`SELECT id,revision FROM assistant.extension_skills WHERE workspace_id=${input.workspace} AND archived_at IS NULL AND enabled AND name ILIKE ${SOURCE[input.kind].skill} ORDER BY updated_at DESC LIMIT 1`)[0];
  const enabled = input.mode === 'watch';
  const row = (await sql`INSERT INTO assistant.attention_sources(workspace_id,conversation_id,kind,account,skill_id,skill_revision,source_message_id,source_quote,enabled,interval_minutes)
    VALUES(${input.workspace},${input.conversation},${input.kind},${input.account.toLowerCase()},${skill?.['id'] ?? null},${skill?.['revision'] ?? null},${input.source_message},${input.source_quote},${enabled},${input.interval_minutes ?? 120})
    ON CONFLICT (workspace_id,kind,account) DO UPDATE SET skill_id=COALESCE(excluded.skill_id,attention_sources.skill_id),skill_revision=COALESCE(excluded.skill_revision,attention_sources.skill_revision),updated_at=now()
    RETURNING *`)[0]!;
  const id = String(row['id']);
  await sql`SELECT 1 FROM assistant.attention_sources WHERE id=${id} FOR UPDATE`;
  if (input.mode === 'once') {
    const running = (await sql`SELECT task_id,conversation_id FROM assistant.attention_source_runs WHERE source_id=${id} AND state='dispatched'`)[0];
    if (running) {
      if (String(running['conversation_id']) !== input.conversation) await sql`UPDATE assistant.attention_source_runs SET also_answer=array_append(also_answer,${input.conversation}::uuid) WHERE task_id=${running['task_id']}`;
      return { id, enabled: row['enabled'], once: 'already looking; the result will be posted here too' };
    }
    const task = await startLook(sql, (await sql`SELECT * FROM assistant.attention_sources WHERE id=${id}`)[0]!, new Date(), { conversation: input.conversation, message: input.source_message });
    return { id, enabled: row['enabled'], once: task };
  }
  const changed = Boolean(row['enabled']) !== enabled;
  // Stop always withdraws everything in flight (a single look, its drafts), whether or not the watch was on.
  if (changed || !enabled) {
    await withdrawRuns(sql, { source: id }, 'withdrawn'); await withdrawDrafts(sql, id);
    // Drafts made under the old permission are not sendable under a new one; a new look re-checks and redrafts.
    await sql`UPDATE assistant.card_states c SET state='replaced',updated_at=now() FROM assistant.attention_source_drafts d
      WHERE d.source_id=${id} AND d.card_message_id=c.message_id AND c.state IN ('pending','snoozed')`;
    await sql`UPDATE assistant.attention_source_drafts SET state='withdrawn' WHERE source_id=${id} AND state='ready'
      AND NOT EXISTS(SELECT 1 FROM assistant.card_states c WHERE c.message_id=card_message_id AND c.state IN ('accepted','resolved'))`;
  }
  if (!enabled) await sql`UPDATE assistant.attention_source_items SET once_until=NULL WHERE source_id=${id}`;
  await sql`UPDATE assistant.attention_sources SET enabled=${enabled},revision=revision+${changed || !enabled ? 1 : 0},conversation_id=CASE WHEN ${enabled} THEN ${input.conversation}::uuid ELSE conversation_id END,source_message_id=${input.source_message},source_quote=${input.source_quote},
    interval_minutes=COALESCE(${input.interval_minutes},interval_minutes),next_check_at=CASE WHEN ${enabled && changed} THEN now() ELSE next_check_at END,
    health=CASE WHEN ${enabled} THEN 'ok' ELSE health END,failure_count=CASE WHEN ${enabled} THEN 0 ELSE failure_count END,updated_at=now() WHERE id=${id}`;
  // A stopped watch's alerts stop at once.
  if (!enabled) { const { withdrawStaleAlerts } = await import('./coordinator'); await withdrawStaleAlerts(sql, input.workspace); }
  return (await sql`SELECT id,enabled,interval_minutes,next_check_at FROM assistant.attention_sources WHERE id=${id}`)[0];
}

/**
 * For 피드 and the brief: open items (one per thread, with the state of its reply draft folded in), and each watch
 * with honest freshness. A single look's blocked login is shown even when the standing watch is off.
 */
export async function sourceView(sql: Query, workspace: string) {
  const [items, unconfirmed, resolved, sources] = await Promise.all([
    sql`SELECT EXISTS(SELECT 1 FROM assistant.attention_source_sends p WHERE p.item_id=i.id AND p.state IN ('dispatched','executing','unknown','checking','needs_user')) AS pending_send,i.waiting_since,i.next_chase_at,i.blocked_reason,i.id,i.subject,i.counterpart,i.category,i.action,i.reason,i.evidence,i.due_at,i.url,i.version,i.briefed_version,i.first_seen_at,i.last_seen_at,s.kind,s.account,
        coalesce(d.conversation_id,i.conversation_id,s.conversation_id) AS conversation_id,d.card_message_id AS draft_message_id,d.card_state AS draft_state,d.preparing,d.snoozed_until,d.draft_job,d.send_task
      FROM assistant.attention_source_items i JOIN assistant.attention_sources s ON s.id=i.source_id
      LEFT JOIN LATERAL (SELECT x.card_message_id,c.state AS card_state,c.snoozed_until,x.state AS draft_job,(x.state='dispatched') AS preparing,m.conversation_id,
          (SELECT CASE WHEN e.state IN ('unknown','checking') THEN 'checking' WHEN e.state='needs_user' THEN 'needs_user' WHEN e.state IN ('dispatched','executing') THEN 'running' ELSE e.state END
             FROM assistant.attention_source_sends e WHERE e.card_message_id=x.card_message_id ORDER BY e.created_at DESC LIMIT 1) AS send_task FROM assistant.attention_source_drafts x
          LEFT JOIN assistant.card_states c ON c.workspace_id=x.workspace_id AND c.message_id=x.card_message_id
          LEFT JOIN assistant.messages m ON m.workspace_id=x.workspace_id AND m.id=x.card_message_id
        WHERE x.item_id=i.id AND x.version=i.version AND x.state IN ('dispatched','ready','failed','expired') ORDER BY x.created_at DESC LIMIT 1) d ON true
      WHERE i.workspace_id=${workspace} AND i.state='open' AND (s.enabled OR i.once_until>now()-interval '7 days')
      ORDER BY i.due_at NULLS LAST,i.last_seen_at DESC LIMIT 60`,
    sql`SELECT e.task_id AS send_task_id,e.card_message_id,e.state,e.note,e.recipient,e.created_at,i.subject,i.url,coalesce(i.conversation_id,s.conversation_id) AS conversation_id
      FROM assistant.attention_source_sends e JOIN assistant.attention_source_items i ON i.id=e.item_id JOIN assistant.attention_sources s ON s.id=i.source_id
      WHERE e.workspace_id=${workspace} AND e.state IN ('unknown','checking','needs_user') ORDER BY e.created_at DESC LIMIT 20`,
    sql`SELECT i.id,i.subject,i.counterpart,i.resolution,i.resolution_note,i.resolution_basis,i.resolved_at,i.url,s.kind,coalesce(i.conversation_id,s.conversation_id) AS conversation_id
      FROM assistant.attention_source_items i JOIN assistant.attention_sources s ON s.id=i.source_id
      WHERE i.workspace_id=${workspace} AND i.state='resolved' AND i.resolved_at>now()-interval '7 days' ORDER BY i.resolved_at DESC LIMIT 20`,
    sql`SELECT s.id,s.kind,s.account,s.conversation_id,s.enabled,s.health,s.last_success_at,s.last_attempt_at,s.next_check_at,s.last_error,s.pending_window_start,
      (SELECT max(r.finished_at) FROM assistant.attention_source_runs r WHERE r.source_id=s.id AND r.state='partial') AS last_partial_at
      FROM assistant.attention_sources s WHERE s.workspace_id=${workspace} AND (s.enabled OR (s.health='needs_user' AND s.updated_at>now()-interval '1 day'))`,
  ]);
  return { items, unconfirmed, resolved, sources };
}
/** After a brief is delivered: exactly the source items (id@version) it was written from are no longer news. */
export async function markSourceItemsBriefed(sql: Query, workspace: string, keys: readonly string[]) {
  for (const key of keys) {
    const m = /^mail:([0-9a-f-]{36}):[^@]*@(.+)$/.exec(key);
    if (m?.[1] && m[2]) await sql`UPDATE assistant.attention_source_items SET briefed_version=${m[2]} WHERE workspace_id=${workspace} AND id=${m[1]} AND version=${m[2]}`;
  }
}

/** Client: what the user says about a thread. Either way its unsent draft can no longer go out. */
/**
 * 답장 from the feed: the user asks for a reply draft on this thread, optionally saying what it should say. A ready or
 * failed draft of the current version is retired so a new one is written with the note; the draft comes back as the
 * usual approval card (nothing is sent without it).
 */
/**
 * Re-check a draft that could not be verified (no thread revision): the same reply request again, keeping the user's
 * note and the text they were about to approve, and only while that card is still the current request's draft.
 */
export async function redraftUnverified(sql: Query, workspace: string, card: string, body: string | null) {
  const row = (await sql`SELECT i.id,i.version,i.reply_request_id,d.reply_request_id AS draft_request,d.version AS draft_version,d.state AS draft_state
    FROM assistant.attention_source_drafts d JOIN assistant.attention_source_items i ON i.id=d.item_id
    WHERE d.workspace_id=${workspace} AND d.card_message_id=${card} AND i.state='open' FOR UPDATE OF i`)[0];
  // Only the current draft of the current request and thread version (a newer request or a changed thread wins).
  if (!row || row['draft_state'] !== 'ready' || row['draft_version'] !== row['version'] || (row['draft_request'] ?? null) !== (row['reply_request_id'] ?? null)) return null;
  if ((await sql`SELECT 1 FROM assistant.attention_source_sends WHERE item_id=${row['id']} AND state IN ('dispatched','executing','unknown','checking','needs_user')`)[0]) return null;
  // The same request again: its id and note stay; the text the user approved is kept on its own.
  await sql`UPDATE assistant.attention_source_items SET reply_keep_body=${body ? body.slice(0, 6000) : null},updated_at=now() WHERE id=${row['id']}`;
  await closeDrafts(sql, workspace, String(row['id']), 'replaced');
  await sql`UPDATE assistant.attention_source_drafts SET state='withdrawn',finished_at=now()-interval '1 hour' WHERE item_id=${row['id']} AND state='ready'`;
  return row['reply_request_id'] ? String(row['reply_request_id']) : 'retry';
}
export async function requestReply(sql: Query, workspace: string, id: string, note: string | null) {
  // Lock first and refuse before changing anything (a refused request leaves the note and permission as they were).
  const item = (await sql`SELECT id,version FROM assistant.attention_source_items WHERE workspace_id=${workspace} AND id=${id} AND state='open' FOR UPDATE`)[0];
  if (!item) return null;
  if ((await sql`SELECT 1 FROM assistant.attention_source_sends WHERE item_id=${id} AND state IN ('dispatched','executing','unknown','checking','needs_user')`)[0]) return null;
  // This request, and only it, may produce the next draft: older drafts (also one being written) no longer count.
  const request = crypto.randomUUID();
  await sql`UPDATE assistant.attention_source_items SET reply_note=${note},reply_keep_body=NULL,reply_request_id=${request},reply_requested_at=now(),action=CASE WHEN category IN ('promise','waiting') THEN action ELSE 'reply' END,
      once_until=greatest(coalesce(once_until,now()),now()+interval '1 day'),updated_at=now() WHERE id=${id}`;
  await closeDrafts(sql, workspace, id, 'replaced');
  await withdrawItemDrafts(sql, id);
  await sql`UPDATE assistant.attention_source_drafts SET state='withdrawn',finished_at=now()-interval '1 hour' WHERE item_id=${id} AND state IN ('ready','failed','expired','handled','not_needed')`;
  return request;
}
/**
 * The user moves an obligation's due date or says it is blocked (and why). Their date is kept over later readings of
 * the thread until the obligation closes; a blocked one does not alert until unblocked or its date passes.
 */
export async function updateObligation(sql: Query, workspace: string, id: string, change: { due_at?: string | null; blocked?: string | null }) {
  const row = (await sql`SELECT id FROM assistant.attention_source_items WHERE workspace_id=${workspace} AND id=${id} AND state='open' FOR UPDATE`)[0];
  if (!row) return false;
  if (change.due_at !== undefined) await sql`UPDATE assistant.attention_source_items SET user_due_at=${change.due_at},due_at=coalesce(${change.due_at}::timestamptz,due_at),updated_at=now() WHERE id=${id}`;
  if (change.blocked !== undefined) await sql`UPDATE assistant.attention_source_items SET blocked_reason=${change.blocked},blocked_at=CASE WHEN ${change.blocked}::text IS NULL THEN NULL ELSE now() END,updated_at=now() WHERE id=${id}`;
  await withdrawAlertsFor(sql, workspace, id);
  return true;
}
export async function answerSourceItem(sql: Query, workspace: string, id: string, how: 'dismiss' | 'handled') {
  const rows = await sql`UPDATE assistant.attention_source_items SET state=${how === 'dismiss' ? 'dismissed' : 'resolved'},resolution=${how === 'handled' ? 'user_marked' : null},resolution_basis=${how === 'handled' ? 'user_confirmed' : null},
    resolved_at=CASE WHEN ${how === 'handled'} THEN now() END,user_due_at=NULL,blocked_reason=NULL,blocked_at=NULL,updated_at=now() WHERE workspace_id=${workspace} AND id=${id} AND state='open' RETURNING id`;
  for (const row of rows) { await closeDrafts(sql, workspace, String(row['id']), how === 'handled' ? 'superseded' : 'replaced'); await withdrawItemDrafts(sql, String(row['id'])); await withdrawAlertsFor(sql, workspace, String(row['id'])); }
  return rows.length > 0;
}
async function withdrawItemDrafts(tx: Query, item: string) {
  const rows = await tx`UPDATE assistant.attention_source_drafts SET state='withdrawn',finished_at=now() WHERE item_id=${item} AND state='dispatched' RETURNING task_id`;
  for (const r of rows) await tx`UPDATE assistant.tasks SET state='cancelled',reason='No longer needed',updated_at=now() WHERE id=${r['task_id']} AND state='queued'`;
}

/** A draft card (or its approval) is still right only while its thread is open at the version it was written for. */
export async function draftStillValid(sql: Query, workspace: string, message: string) {
  const row = (await sql`SELECT i.category,d.version,d.state AS draft_state,d.reply_request_id,i.reply_request_id AS current_request,d.source_revision,i.state,i.version AS current,i.action,i.once_until,s.enabled,s.revision FROM assistant.attention_source_drafts d
    JOIN assistant.attention_source_items i ON i.id=d.item_id JOIN assistant.attention_sources s ON s.id=d.source_id
    WHERE d.workspace_id=${workspace} AND d.card_message_id=${message}`)[0];
  if (!row) return { linked: false as const };
  // The draft was made under this permission (no stop/restart since) and its thread has not changed. The short window for
  // making drafts after a single look does not limit sending one already shown: the send re-checks the thread anyway.
  // ...and it is the draft of the current reply request (a rewrite asked for since makes older cards unusable).
  const ok = row['state'] === 'open' && row['current'] === row['version'] && (row['action'] === 'reply' || row['category'] === 'promise' || row['category'] === 'waiting') && Number(row['source_revision']) === Number(row['revision'])
    && row['draft_state'] === 'ready' && (row['reply_request_id'] ?? null) === (row['current_request'] ?? null);
  return { linked: true as const, ok: !!ok };
}

/** What a foreground task needs to send an approved Gmail reply exactly: account, thread, recipient, subject. */
export async function draftSendContext(sql: Query, workspace: string, message: string) {
  const row = (await sql`SELECT s.account,s.kind,i.thread_key,i.url,i.subject,i.counterpart,i.version FROM assistant.attention_source_drafts d
    JOIN assistant.attention_source_items i ON i.id=d.item_id JOIN assistant.attention_sources s ON s.id=d.source_id WHERE d.workspace_id=${workspace} AND d.card_message_id=${message}`)[0];
  if (!row) return null;
  const src = SOURCE[row['kind'] as Kind];
  return [`${src.name} account: ${String(row['account'])}`, `Thread: ${String(row['thread_key'])}${row['url'] ? ` ${String(row['url'])}` : ''} (version ${String(row['version'])})`,
    `Subject: ${String(row['subject'])}`, row['counterpart'] ? `Reply to: ${String(row['counterpart'])}` : '',
    `${src.send} Right before sending, check the thread has no newer message than this version; if it does, do not send: tell the user what changed.`].filter(Boolean).join('\n');
}

/** One reply draft per thread version, prepared by a run that re-reads the thread (never from the stored summary). */
export function replyObjective(item: { kind?: Kind; account: string; url: string | null; thread_key: string; subject: string; counterpart: string | null; reason: string; evidence: string | null; note?: string | null; keep?: string | null; promise?: boolean; chase?: boolean }) {
  return [
    ...(item.chase ? ['The user is waiting for an answer from the other side and it is late (see Why). Draft a short, polite follow-up in this thread that asks once more for what is pending, with the date it was asked; do not answer HANDLED or NOT_NEEDED unless the answer has in fact arrived.'] : []),
    ...(item.promise ? ['This thread holds something the user promised (see Why). Draft the reply in this thread that delivers it as text and links from the note; it cannot carry attachments, so never say something is attached (if a file is needed, say in your last line that the user should attach it in Gmail). Do not answer HANDLED because the user already replied — the promise is still open.'] : []),
    ...(item.keep ? [`The user already approved this text but it could not be checked against the thread; keep it unless the thread now says otherwise: """${item.keep}"""`] : []),
    ...(item.note ? [`The user asked for this reply and said what it should say: "${item.note.slice(0, 1600)}". Write the draft from that (never NOT_NEEDED or HANDLED unless the thread already has exactly that reply).`] : []),
    `Prepare a reply draft for a ${SOURCE[item.kind ?? 'gmail'].name} thread in ${item.account} that needs the user's answer. Read only; do not send.`,
    `Thread: ${item.subject}${item.counterpart ? ` (from ${item.counterpart})` : ''}, id ${item.thread_key}${item.url ? `, ${item.url}` : ''}. Why: ${item.reason}${item.evidence ? `; they wrote: "${item.evidence}"` : ''}.`,
    SOURCE[item.kind ?? 'gmail'].reread,
    'If the account already replied after the asking message and no newer request is unanswered, reply exactly HANDLED: <reply sender>|<reply time> <short quote>. If no answer from the user is needed, reply exactly NOT_NEEDED: <why>.',
    `Otherwise call ask_user once with a draft card (channel "${SOURCE[item.kind ?? 'gmail'].name}", target = the recipient (Slack: "#channel" or the person), title = ${item.kind === 'slack' ? 'null' : '"Re: <subject>"'}, body = the reply in the user's usual tone and language; do not invent facts or commitments, leave [ ] for what only the user knows) and question null.`,
    'Then end with one short line: what the draft answers. Never call notify_user.',
  ].join(' ');
}
const DRAFT_ATTEMPTS = 2;
async function dispatchReplyDrafts(sql: Database, now: Date) {
  // Only threads the user's permission still covers: an enabled watch, or a single look's short window.
  const items = await sql`SELECT i.category,i.reply_note,i.id,i.thread_key,i.url,i.subject,i.counterpart,i.reason,i.evidence,i.version,s.kind,s.id AS source_id,s.revision,s.workspace_id,s.conversation_id,s.account,s.skill_id,s.skill_revision,
      i.conversation_id AS once_conversation
    FROM assistant.attention_source_items i JOIN assistant.attention_sources s ON s.id=i.source_id
    WHERE i.state='open' AND (i.action='reply' OR i.category IN ('promise','waiting') AND i.reply_request_id IS NOT NULL) AND (s.enabled OR i.once_until>${now})
      AND (i.category<>'waiting' OR i.next_chase_at IS NULL OR i.next_chase_at<=${now})
      AND NOT EXISTS(SELECT 1 FROM assistant.attention_source_sends e WHERE e.item_id=i.id AND e.state IN ('dispatched','executing','unknown','checking','needs_user'))
      AND NOT EXISTS(SELECT 1 FROM assistant.attention_source_drafts d WHERE d.item_id=i.id AND d.version=i.version AND d.state IN ('dispatched','ready','handled','not_needed'))
      AND (SELECT count(*) FROM assistant.attention_source_drafts d WHERE d.item_id=i.id AND d.version=i.version AND d.state IN ('failed','expired'))<${DRAFT_ATTEMPTS}
      AND NOT EXISTS(SELECT 1 FROM assistant.attention_source_drafts d WHERE d.item_id=i.id AND d.state IN ('failed','expired') AND d.finished_at>${now}::timestamptz-interval '20 minutes')
      AND NOT EXISTS(SELECT 1 FROM assistant.attention_source_runs r WHERE r.source_id=s.id AND r.state='dispatched')
    ORDER BY i.first_seen_at LIMIT 3`;
  for (const i of items) {
    await sql.begin(async tx => {
      // Read the request under the lock: the note and request id the draft is written for.
      // Every condition again under the item's lock (a follow-up may have just been sent and used up the request).
      const locked = (await tx`SELECT reply_note,reply_request_id,reply_keep_body,category FROM assistant.attention_source_items WHERE id=${i['id']} AND state='open' AND version=${i['version']}
        AND (action='reply' OR category IN ('promise','waiting') AND reply_request_id IS NOT NULL)
        AND (category<>'waiting' OR next_chase_at IS NULL OR next_chase_at<=${now})
        AND NOT EXISTS(SELECT 1 FROM assistant.attention_source_sends e WHERE e.item_id=${i['id']} AND e.state IN ('dispatched','executing','unknown','checking','needs_user'))
        FOR UPDATE SKIP LOCKED`)[0];
      if (!locked || (await tx`SELECT 1 FROM assistant.attention_source_drafts WHERE item_id=${i['id']} AND state='dispatched'`)[0]) return;
      // Quiet hours hold the assistant's own drafts, not one the user just asked for.
      if (!locked['reply_request_id'] && await quietWait(tx, String(i['workspace_id']), now)) return;
      const objective = replyObjective({ kind: i['kind'] as Kind, account: String(i['account']), url: i['url'] ? String(i['url']) : null, thread_key: String(i['thread_key']), subject: String(i['subject']), counterpart: i['counterpart'] ? String(i['counterpart']) : null, reason: String(i['reason']), promise: i['category'] === 'promise', chase: i['category'] === 'waiting', note: locked['reply_note'] ? String(locked['reply_note']) : null, keep: locked['reply_keep_body'] ? String(locked['reply_keep_body']) : null, evidence: i['evidence'] ? String(i['evidence']) : null });
      const conversation = String(i['once_conversation'] ?? i['conversation_id']);
      const created = await createBackgroundTask(tx, { workspace: String(i['workspace_id']), conversation, objective, title: '답장 초안', origin: 'responsibility', clientId: crypto.randomUUID() });
      if (i['skill_id'] && i['skill_revision']) await bindSkill(tx, { workspace: String(i['workspace_id']), task: created.task.id, message: created.message.id, skill: String(i['skill_id']), revision: Number(i['skill_revision']), kind: 'scheduled' });
      await tx`INSERT INTO assistant.attention_source_drafts(purpose,reply_request_id,task_id,workspace_id,source_id,item_id,source_revision,version,expires_at) VALUES(${i['category'] === 'waiting' ? 'chase' : i['category'] === 'promise' ? 'deliver' : 'reply'},${locked['reply_request_id'] ?? null},${created.task.id},${String(i['workspace_id'])},${String(i['source_id'])},${String(i['id'])},${Number(i['revision'])},${String(i['version'])},${now}::timestamptz+${OBSERVE_TTL_MINUTES}*interval '1 minute')`;
    });
  }
}

/**
 * A draft job produced output. Its card is accepted only while the job is live and the thread is still open at the
 * version it was written for; otherwise the output is hidden. HANDLED / NOT_NEEDED close the item with that evidence.
 * Returns null when the task is not a draft job; else whether to hide the message and whether a card may register.
 */
export async function gateDraftOutput(sql: Query, workspace: string, task: string, out: { readonly content: string; readonly hasDraft: boolean; readonly final: boolean }) {
  const job = (await sql`SELECT d.*,i.state AS item_state,i.version AS current,i.reply_request_id AS current_request,s.enabled,s.revision,i.once_until FROM assistant.attention_source_drafts d
    JOIN assistant.attention_source_items i ON i.id=d.item_id JOIN assistant.attention_sources s ON s.id=d.source_id
    WHERE d.workspace_id=${workspace} AND d.task_id=${task} FOR UPDATE OF d`)[0];
  if (!job) return null;
  const permitted = job['enabled'] ? Number(job['revision']) === Number(job['source_revision']) : !!job['once_until'] && new Date(String(job['once_until'])) > new Date();
  // Written for an older reply request (the user asked again meanwhile): not shown, not closing anything.
  const sameRequest = (job['reply_request_id'] ?? null) === (job['current_request'] ?? null);
  const live = job['state'] === 'dispatched' && job['item_state'] === 'open' && job['current'] === job['version'] && permitted && sameRequest;
  if (!live) {
    if (job['state'] === 'dispatched') await sql`UPDATE assistant.attention_source_drafts SET state='withdrawn',finished_at=now() WHERE task_id=${task}`;
    return { hidden: true, register: false };
  }
  const text = out.content.trim();
  const handled = /^HANDLED:\s*(.*)$/s.exec(text), notNeeded = /^NOT_NEEDED:\s*(.*)$/s.exec(text);
  if (out.final && (handled || notNeeded)) {
    const note = (handled?.[1] ?? notNeeded?.[1] ?? '').trim().slice(0, 400);
    // Closing a thread needs a reason from the thread; a bare marker is a failed attempt, not a resolution.
    if (note.length < 8) {
      await sql`UPDATE assistant.attention_source_drafts SET state='failed',note='closed without evidence',finished_at=now() WHERE task_id=${task}`;
      return { hidden: true, register: false };
    }
    await sql`UPDATE assistant.attention_source_drafts SET state=${handled ? 'handled' : 'not_needed'},note=${note},finished_at=now() WHERE task_id=${task}`;
    await sql`UPDATE assistant.attention_source_items SET state='resolved',resolution=${handled ? 'replied' : 'not_needed'},resolution_note=${note},handled_evidence=${handled ? note.slice(0, 200) : null},resolution_basis=${handled ? 'observed_reply' : null},resolved_at=now(),updated_at=now() WHERE id=${job['item_id']} AND state='open' AND category NOT IN ('promise','waiting')`;
    await closeDrafts(sql, workspace, String(job['item_id']), 'superseded');
    return { hidden: true, register: false };
  }
  return { hidden: !out.hasDraft && !out.final, register: out.hasDraft };
}
/** A draft job stored its card: it replaces an older unsent draft for the same thread. */
/** The daemon records the revision a draft job read (its last source_gmail_thread of the item's thread). */
/**
 * A Gmail print-view time ("2026년 10월 25일 오전 10:13") as ISO; anything else is kept as it is. The print view
 * renders in the browser's time zone, which on the VM is UTC (PRINT_VIEW_OFFSET overrides, e.g. "+09:00").
 */
export function printTime(text: string): string {
  const m = /(\d{4})년\s*(\d{1,2})월\s*(\d{1,2})일\s*(오전|오후)\s*(\d{1,2}):(\d{2})/.exec(text);
  if (!m) return text;
  let h = Number(m[5]) % 12; if (m[4] === '오후') h += 12;
  const pad = (n: string | number) => String(n).padStart(2, '0');
  const d = new Date(`${m[1]}-${pad(m[2]!)}-${pad(m[3]!)}T${pad(h)}:${m[6]}:00${PRINT_VIEW_OFFSET}`);
  return Number.isNaN(d.getTime()) ? text : d.toISOString();
}
const PRINT_VIEW_OFFSET = (typeof process !== 'undefined' && process.env?.['PRINT_VIEW_OFFSET']) || 'Z';
/**
 * How a new reading of a thread changes its item, decided once. "same" = the same obligation (what the user set on it
 * stays: their date, blocked reason, reply note); a new one starts from the thread.
 * - An open promise stays the promise: a reading cannot re-label it (overdue is a date, not a kind) or replace its text.
 *   A new request on that thread is kept waiting behind it (the promise stays the item; the request shows in its reason).
 * - An anchor that was unknown and is now known is the same obligation, not a new one.
 * - A closed item reopens for a new request (another anchor), or as a promise the user made in a reply.
 */
export function mergeObligation(before: Record<string, unknown> | null, item: z.infer<typeof ObservationItem>) {
  const fresh = { category: item.category as string, action: item.action as string, reason: item.reason, evidence: item.evidence, due_at: item.due_at, request_anchor: item.request_anchor };
  if (!before) return { ...fresh, state: 'open', keepResolved: false, same: false };
  const open = before['state'] === 'open';
  const anchorBefore = before['request_anchor'] ? String(before['request_anchor']) : null;
  const newAnchor = !!item.request_anchor && !!anchorBefore && item.request_anchor !== anchorBefore;
  const userDue = before['user_due_at'] ? new Date(String(before['user_due_at'])).toISOString() : null;
  if (open && before['category'] === 'promise') {
    // The promise holds; a new request from the other side is noted, not swapped in.
    const note = ` · 새 요청도 있어요: ${item.reason}`;
    const reason = newAnchor && item.category === 'request' && !String(before['reason']).includes(note) ? `${String(before['reason'])}${note}`.slice(0, 400) : String(before['reason']);
    return { category: 'promise', action: String(before['action']), reason, evidence: before['evidence'] ? String(before['evidence']) : null,
      due_at: userDue ?? (before['due_at'] ? new Date(String(before['due_at'])).toISOString() : item.due_at), request_anchor: anchorBefore ?? item.request_anchor,
      state: 'open', keepResolved: false, same: true };
  }
  // A wait read again for the same request stays a wait (late is a date, not a kind).
  if (open && before['category'] === 'waiting' && !newAnchor && item.category !== 'promise') {
    return { ...fresh, category: 'waiting', action: String(before['action']), due_at: userDue ?? item.due_at, request_anchor: anchorBefore ?? item.request_anchor, state: 'open', keepResolved: false, same: true };
  }
  const becomesPromise = item.category === 'promise' && before['category'] !== 'promise';
  const same = !newAnchor && !becomesPromise && (open || (item.request_anchor ? item.request_anchor === anchorBefore : before['version'] === item.version));
  const reopen = !open && (newAnchor || becomesPromise || (!item.request_anchor && before['version'] !== item.version));
  return { ...fresh, due_at: same && userDue ? userDue : item.due_at, request_anchor: item.request_anchor ?? anchorBefore,
    state: open || reopen ? 'open' : String(before['state']), keepResolved: !open && !reopen, same: same && (open || !reopen) };
}
/**
 * A wait is answered only by a message this look read in the thread (its adapter snapshot) from someone other than the
 * account, at or after the time the user asked. answered_by is "<address>|<time>" as read.
 */
function waitAnswered(run: Record<string, unknown>, r: z.infer<typeof Resolution>, item: Record<string, unknown> | undefined) {
  if (r.how !== 'done' || !r.answered_by || !item) return false;
  const snap = (run['thread_snapshots'] as Record<string, { messages?: ThreadMessage[] }> | null)?.[r.thread_key];
  const [address, time] = r.answered_by.split('|').map(v => v.trim());
  if (!address || !time) return false;
  const at = Date.parse(printTime(time));
  if (Number.isNaN(at)) return false;
  const account = String(run['account']).toLowerCase();
  // Asked when: the wait's own time, else its anchor's time. Without either the wait is not closed automatically.
  const askedAt = item['waiting_since'] ? new Date(String(item['waiting_since'])).getTime()
    : Date.parse(printTime(String(item['request_anchor'] ?? '').split('|')[1]?.trim() ?? ''));
  if (Number.isNaN(askedAt)) return false;
  // The answer: a message this look read, from that address (not the account), at that time, after the ask.
  return !!snap?.messages?.some(m => {
    const from = m.from_address?.toLowerCase();
    const mAt = Date.parse(printTime(m.at));
    return !!from && from === address.toLowerCase() && from !== account && !Number.isNaN(mAt) && Math.abs(mAt - at) < 60_000 && mAt > askedAt;
  });
}
export type ThreadMessage = { from: string; from_address: string | null; at: string; to: string; body: string };
/** The daemon stores the adapter's whole reading of a thread on its item (shown in the feed's thread view). */
export async function noteThreadSnapshot(sql: Query, workspace: string, task: string, thread: string, messages: ThreadMessage[], cut = false) {
  const truncated = cut || messages.length > 30 || messages.some(m => m.body.length > 6000);
  const trimmed = messages.slice(-30).map(m => ({ ...m, at: printTime(m.at), body: m.body.slice(0, 6000) }));
  // A look reads threads before its report creates their items: keep the reading on the run until then.
  await sql`UPDATE assistant.attention_source_runs SET thread_snapshots=thread_snapshots||jsonb_build_object(${thread}::text,jsonb_build_object('messages',${JSON.stringify(trimmed)}::text::jsonb,'truncated',${truncated}))
    WHERE workspace_id=${workspace} AND task_id=${task}`;
  await sql`UPDATE assistant.attention_source_items i SET thread_snapshot=${JSON.stringify({ messages: trimmed, truncated })}::text::jsonb,thread_read_at=now()
    WHERE i.workspace_id=${workspace} AND i.thread_key=${thread}
      AND i.source_id IN (SELECT source_id FROM assistant.attention_source_runs WHERE task_id=${task} UNION SELECT source_id FROM assistant.attention_source_drafts WHERE task_id=${task})`;
}
export async function noteDraftRevision(sql: Query, workspace: string, task: string, thread: string, revision: string) {
  await sql`UPDATE assistant.attention_source_drafts d SET revision=${revision} FROM assistant.attention_source_items i
    WHERE d.workspace_id=${workspace} AND d.task_id=${task} AND d.state='dispatched' AND i.id=d.item_id AND i.thread_key=${thread}`;
}
export async function linkReplyDraft(sql: Query, workspace: string, task: string, message: string) {
  const job = (await sql`SELECT item_id FROM assistant.attention_source_drafts WHERE workspace_id=${workspace} AND task_id=${task} AND state='dispatched' FOR UPDATE`)[0];
  if (!job) return false;
  await closeDrafts(sql, workspace, String(job['item_id']), 'replaced');
  await sql`UPDATE assistant.attention_source_drafts SET state='ready',card_message_id=${message},finished_at=now() WHERE task_id=${task}`;
  return true;
}

/**
 * The dedicated sender for an approved reply to a watched thread. The approval does not become a chat request: a send
 * job is created with the approved envelope (body + hash, account, thread, version, the recipient shown on the card).
 * The daemon runs it without a model: it claims the envelope once and runs the fixed Gmail send adapter, which checks
 * the thread, sends once and reads it back. The result card is made by code from that read-back.
 */
export async function bodyHash(body: string) {
  const digest = new Uint8Array(await crypto.subtle.digest('SHA-256', new TextEncoder().encode(body.replace(/\r\n/g, '\n').trim())));
  return Array.from(digest, b => b.toString(16).padStart(2, '0')).join('');
}
/** The send job's objective is only a label: the daemon runs the fixed send adapter, no model reads it. */
export function sendObjective(s: { kind: Kind; account: string; thread_key: string; subject: string }) {
  return `Send one approved ${SOURCE[s.kind].name} reply (${s.account}, thread ${s.thread_key}, "${s.subject.slice(0, 80)}").`;
}
export async function startSend(sql: Query, input: { workspace: string; card: string; block: string; body: string; recipient: string | null }) {
  // The card must name exactly one address; a bare name is not enough to send to.
  const addresses = input.recipient?.match(/[\w.+-]+@[\w.-]+\.[a-z]{2,}/gi) ?? [];
  const address = addresses.length === 1 ? addresses[0]!.toLowerCase() : null;
  if (!address) return { blocked: '받는 사람 주소가 카드에 없어서 보낼 수 없어요. 수정에서 주소를 넣어 주세요.' };
  const row = (await sql`SELECT d.purpose,i.request_anchor,i.id,i.thread_key,i.url,i.subject,i.counterpart,i.version,d.revision AS draft_revision,s.kind,s.account,coalesce(i.conversation_id,s.conversation_id) AS conversation_id
    FROM assistant.attention_source_drafts d JOIN assistant.attention_source_items i ON i.id=d.item_id JOIN assistant.attention_sources s ON s.id=d.source_id
    WHERE d.workspace_id=${input.workspace} AND d.card_message_id=${input.card}`)[0];
  if (!row) return null;
  if (row['kind'] !== 'gmail') return { blocked: 'Slack 답장 발송은 아직 직접 해 주세요. 초안은 복사해서 쓰시면 돼요.' };
  // One open send per thread, across cards and versions: an unknown outcome must be checked before anything else goes.
  const open = (await sql`SELECT state FROM assistant.attention_source_sends WHERE item_id=${row['id']} AND state IN ('dispatched','executing','unknown','checking','needs_user')`)[0];
  if (open) return { blocked: open['state'] === 'needs_user' ? '앞선 답장이 나갔는지 확인되지 않았어요. 피드에서 다시 확인해 주세요' : open['state'] === 'unknown' || open['state'] === 'checking' ? '앞선 답장이 나갔는지 확인하고 있어요. 확인이 끝나면 알려 드릴게요' : '이미 보내는 중이에요' };
  // The revision the draft was written from; without it the draft cannot be checked against the thread.
  // Not sendable as it is: the caller starts a fresh draft for this thread (outside this refused approval).
  if (!row['draft_revision']) return { blocked: '이 초안은 메일 원문을 끝까지 확인하지 못해서 보낼 수 없었어요. 원문을 다시 읽고 새 초안을 만들고 있어요', redraft: input.card, body: input.body };
  const objective = sendObjective({ kind: row['kind'] as Kind, account: String(row['account']), thread_key: String(row['thread_key']), subject: String(row['subject']) });
  const created = await createBackgroundTask(sql, { workspace: input.workspace, conversation: String(row['conversation_id']), objective, title: '답장 보내기', origin: 'responsibility', clientId: crypto.randomUUID() });
  // The envelope: what the user saw on the card (recipient from the card, not re-read), the thread and its message count.
  await sql`INSERT INTO assistant.attention_source_sends(purpose,request_anchor,item_version,task_id,workspace_id,card_message_id,block_id,item_id,account,thread_key,version,body,body_hash,recipient,recipient_address,revision)
    VALUES(${String(row['purpose'] ?? 'reply')},${row['request_anchor'] ?? null},${String(row['version'])},${created.task.id},${input.workspace},${input.card},${input.block},${String(row['id'])},${String(row['account'])},${String(row['thread_key'])},${String(row['version'])},${input.body},${await bodyHash(input.body)},
      ${input.recipient},${address},${String(row['draft_revision'])})`;
  return { task: created.task, conversation: String(row['conversation_id']) };
}
/**
 * The daemon claims the envelope once. A refused claim is not a send outcome: it returns the current state and the
 * daemon stops without reporting. A second claim of an executing send (restart mid-send) makes it unknown and starts a
 * check. The envelope's revision is the adapter's reading of the thread at approval (pinned by the first claim).
 */
export async function claimSend(sql: Query, workspace: string, task: string) {
  const send = (await sql`UPDATE assistant.attention_source_sends SET state='executing',claimed_at=now() WHERE workspace_id=${workspace} AND task_id=${task} AND state='dispatched' RETURNING *`)[0];
  if (!send) {
    const prior = (await sql`SELECT * FROM assistant.attention_source_sends WHERE workspace_id=${workspace} AND task_id=${task} FOR UPDATE`)[0];
    if (prior?.['state'] === 'executing') {
      await sql`UPDATE assistant.attention_source_sends SET state='unknown',attempted=true,note='claimed twice (restart during send)' WHERE task_id=${task}`;
      await startSendCheck(sql, workspace, task);
    }
    return { claimed: false, state: prior ? String(prior['state']) : 'none' };
  }
  const ok = (await sql`SELECT 1 FROM assistant.attention_source_items WHERE id=${send['item_id']} AND state='open' AND version=${send['version']}`)[0];
  if (!ok) {
    await sql`UPDATE assistant.attention_source_sends SET state='refused',note='thread changed or handled before sending',finished_at=now() WHERE task_id=${task}`;
    await sql`UPDATE assistant.card_states SET state='replaced',updated_at=now() WHERE workspace_id=${workspace} AND message_id=${send['card_message_id']} AND block_id=${send['block_id']}`;
    return { claimed: false, state: 'refused' };
  }
  return { claimed: true, account: String(send['account']), thread_id: String(send['thread_key']), body: String(send['body']),
    recipient_address: String(send['recipient_address']), revision: send['revision'] ? String(send['revision']) : null };
}
/** Old envelopes without a revision cannot be sent: the daemon never fills it from the thread at send time. */
export async function pinSendRevision(sql: Query, workspace: string, task: string, _revision: string) {
  const r = (await sql`SELECT revision FROM assistant.attention_source_sends WHERE workspace_id=${workspace} AND task_id=${task}`)[0];
  return { revision: r?.['revision'] ? String(r['revision']) : null };
}
export async function isSendTask(sql: Query, workspace: string, task: string) {
  return (await sendJobKind(sql, workspace, task)) !== null;
}
export const SendResult = z.object({ outcome: z.enum(['sent', 'not_sent', 'unknown', 'refused']), attempted: z.boolean(), evidence: z.string().max(400) }).strict();
/**
 * The daemon reports what the fixed adapter observed. "sent" comes from the adapter's read-back (the approved text in
 * the thread), not from a model. not_sent is accepted only if Send was never clicked; then the card may be approved
 * again. unknown starts a read-only check of the thread; nothing else is sent for that thread until it settles.
 */
export async function recordSendResult(sql: Query, workspace: string, task: string, input: unknown) {
  const send = (await sql`SELECT * FROM assistant.attention_source_sends WHERE workspace_id=${workspace} AND task_id=${task} FOR UPDATE`)[0];
  if (!send) return { recorded: false, reason: 'not a send job' };
  if (send['state'] !== 'executing') return { recorded: false, reason: `already ${send['state']}` };
  const r = SendResult.parse(input);
  // Once Send may have been clicked, nothing weaker than a read-back can say it did not go out.
  const attempted = r.attempted || Boolean(send['attempted']);
  const outcome = r.outcome === 'not_sent' && attempted ? 'unknown' : r.outcome;
  await sql`UPDATE assistant.attention_source_sends SET state=${outcome},attempted=${attempted},note=${r.evidence},finished_at=${outcome === 'unknown' ? null : new Date()} WHERE task_id=${task}`;
  await settleSendOutcome(sql, workspace, send, outcome);
  return { recorded: true, outcome };
}
async function settleSendOutcome(sql: Query, workspace: string, send: Record<string, unknown>, outcome: string) {
  const card = String(send['card_message_id']), block = String(send['block_id']);
  if (outcome === 'sent') {
    const item = (await sql`SELECT i.subject,i.url,s.kind,s.account,coalesce(i.conversation_id,s.conversation_id) AS conversation_id FROM assistant.attention_source_items i JOIN assistant.attention_sources s ON s.id=i.source_id WHERE i.id=${String(send['item_id'])}`)[0]!;
    const result = { kind: 'result', action: 'sent', channel: `${SOURCE[item['kind'] as Kind].name} (${String(item['account'])})`, target: send['recipient'] ? String(send['recipient']) : null,
      title: String(item['subject']).slice(0, 200), body: String(send['body']).slice(0, 4000), url: item['url'] ? String(item['url']) : null, at: new Date().toISOString(), card: `${card}:${block}` };
    const msg = (await sql`INSERT INTO assistant.messages(workspace_id,conversation_id,task_id,role,content,origin,phase,blocks)
      VALUES(${workspace},${String(item['conversation_id'])},${String(send['task_id'])},'assistant',${String(send['note'] ?? '').startsWith('the user confirmed') ? `${result.target ?? ''}에게 보낸 답장을 확인해 주셨어요.`.trim() : `${result.target ?? ''}에게 답장을 보냈어요.`.trim()},'responsibility','final_answer',${JSON.stringify([result])}::text::jsonb) RETURNING id`)[0]!;
    await sql`UPDATE assistant.card_states SET state='resolved',retry_ok=false,result_message_id=${msg['id']},updated_at=now() WHERE workspace_id=${workspace} AND message_id=${card} AND block_id=${block}`;
    // The reply answered the request: the item leaves 지금 할 일 now (a new request from the other side reopens it).
    // Only the request this reply answered: a newer request that arrived meanwhile stays open.
    await sql`UPDATE assistant.attention_source_items SET state='resolved',resolution='replied',resolution_note=${'여기서 승인한 답장을 보냈어요'},resolution_basis='sent_here',resolved_at=now(),updated_at=now()
      WHERE id=${String(send['item_id'])} AND state='open' AND ${String(send['purpose'] ?? 'reply')}='reply' AND category NOT IN ('promise','waiting')
        AND (CASE WHEN ${send['request_anchor'] ? String(send['request_anchor']) : null}::text IS NOT NULL AND request_anchor IS NOT NULL THEN request_anchor=${send['request_anchor'] ? String(send['request_anchor']) : null}::text ELSE version=${String(send['item_version'] ?? send['version'])} END)`;
    await withdrawAlertsFor(sql, workspace, String(send['item_id']));
    // A follow-up went out: the wait goes on, and the next follow-up is not offered for three days.
    if (send['purpose'] !== 'reply') await sql`UPDATE assistant.attention_source_items SET
        next_chase_at=CASE WHEN ${send['purpose'] === 'chase'} THEN now()+interval '3 days' ELSE next_chase_at END,reply_request_id=NULL,reply_note=NULL,updated_at=now()
      WHERE id=${String(send['item_id'])} AND state='open'
        AND (CASE WHEN ${send['request_anchor'] ? String(send['request_anchor']) : null}::text IS NOT NULL THEN request_anchor=${send['request_anchor'] ? String(send['request_anchor']) : null}::text
          ELSE request_anchor IS NULL AND category=${send['purpose'] === 'chase' ? 'waiting' : 'promise'} END)`;
    await sql`WITH e AS (INSERT INTO assistant.events(workspace_id,kind,payload) VALUES(${workspace},'message.created',${JSON.stringify({ message: { id: msg['id'] } })}::text::jsonb) RETURNING id) INSERT INTO assistant.outbox(workspace_id,event_id) SELECT ${workspace},id FROM e`;
  } else if (outcome === 'refused') {
    await sql`UPDATE assistant.card_states SET state='replaced',retry_ok=false,updated_at=now() WHERE workspace_id=${workspace} AND message_id=${card} AND block_id=${block}`;
  } else if (outcome === 'not_sent') {
    await sql`UPDATE assistant.card_states SET state='failed',retry_ok=true,updated_at=now() WHERE workspace_id=${workspace} AND message_id=${card} AND block_id=${block}`;
  } else {
    // unknown: a read-only check reads the thread back; the card stays accepted (shown as 확인 중).
    await startSendCheck(sql, workspace, String(send['task_id']));
  }
}
/** A read-only look at the one thread to settle an unknown send: is the approved text there? */
async function startSendCheck(sql: Query, workspace: string, sendTask: string) {
  const send = (await sql`SELECT e.*,i.conversation_id AS ic,s.conversation_id AS sc FROM assistant.attention_source_sends e JOIN assistant.attention_source_items i ON i.id=e.item_id JOIN assistant.attention_sources s ON s.id=i.source_id WHERE e.task_id=${sendTask}`)[0];
  if (!send || (send['check_task_id'] && send['state'] === 'checking')) return;
  if (Number(send['check_attempts']) >= 3) {
    await sql`UPDATE assistant.attention_source_sends SET state='needs_user',check_task_id=NULL,note='could not confirm after 3 checks' WHERE task_id=${sendTask}`;
    return;
  }
  const created = await createBackgroundTask(sql, { workspace, conversation: String(send['ic'] ?? send['sc']), objective: `Check whether an approved reply went out (thread ${String(send['thread_key'])}).`, title: '발송 확인', origin: 'responsibility', clientId: crypto.randomUUID() });
  await sql`UPDATE assistant.attention_source_sends SET state='checking',check_task_id=${created.task.id},check_attempts=check_attempts+1 WHERE task_id=${sendTask}`;
  await sql`INSERT INTO assistant.attention_source_check_tasks(task_id,workspace_id,send_task_id) VALUES(${created.task.id},${workspace},${sendTask}) ON CONFLICT DO NOTHING`;
}
/** The check job (daemon, no model) reports: the approved text is in the thread (sent) or not (not_sent). */
export async function claimSendCheck(sql: Query, workspace: string, task: string) {
  const send = (await sql`SELECT * FROM assistant.attention_source_sends WHERE workspace_id=${workspace} AND check_task_id=${task} AND state='checking'`)[0];
  return send ? { claimed: true, account: String(send['account']), thread_id: String(send['thread_key']), body: String(send['body']), revision: String(send['revision'] ?? '0||') } : { claimed: false, state: 'none' };
}
export async function recordSendCheck(sql: Query, workspace: string, task: string, foundIn: boolean | null, evidence: string) {
  // After Send may have been clicked, not seeing the message is not proof it did not go out: only "found" settles.
  const found = foundIn === true ? true : null;
  const send = (await sql`SELECT * FROM assistant.attention_source_sends WHERE workspace_id=${workspace} AND check_task_id=${task} AND state='checking' FOR UPDATE`)[0];
  if (!send) return { recorded: false };
  if (found === null) {
    await sql`UPDATE assistant.attention_source_sends SET state='unknown',note=${evidence} WHERE task_id=${send['task_id']}`;
    await startSendCheck(sql, workspace, String(send['task_id']));
    return { recorded: true, outcome: 'unknown' };
  }
  const outcome = found ? 'sent' : 'not_sent';
  await sql`UPDATE assistant.attention_source_sends SET state=${outcome},note=${evidence},finished_at=now() WHERE task_id=${send['task_id']}`;
  await settleSendOutcome(sql, workspace, send, outcome);
  return { recorded: true, outcome };
}
export async function sendJobKind(sql: Query, workspace: string, task: string): Promise<'send' | 'check' | null> {
  if ((await sql`SELECT 1 FROM assistant.attention_source_sends WHERE workspace_id=${workspace} AND task_id=${task}`)[0]) return 'send';
  if ((await sql`SELECT 1 FROM assistant.attention_source_check_tasks WHERE workspace_id=${workspace} AND task_id=${task}`)[0]) return 'check';
  return null;
}
/** The send job ended without a result: cancelled before it was claimed is not_sent; anything later is unknown. */
export async function settleSendTask(sql: Query, workspace: string, task: string, state: string) {
  if (!['succeeded', 'failed', 'cancelled', 'unknown'].includes(state)) return;
  // A check job that ended without a result: try again (bounded), the send stays unconfirmed.
  const checking = (await sql`SELECT task_id FROM assistant.attention_source_sends WHERE workspace_id=${workspace} AND check_task_id=${task} AND state='checking' FOR UPDATE`)[0];
  if (checking) { await sql`UPDATE assistant.attention_source_sends SET state='unknown' WHERE task_id=${checking['task_id']}`; await startSendCheck(sql, workspace, String(checking['task_id'])); return; }
  const send = (await sql`SELECT * FROM assistant.attention_source_sends WHERE workspace_id=${workspace} AND task_id=${task} AND state IN ('dispatched','executing') FOR UPDATE`)[0];
  if (!send) return;
  const outcome = send['state'] === 'dispatched' ? 'not_sent' : 'unknown';
  await sql`UPDATE assistant.attention_source_sends SET state=${outcome},note='ended without a result',finished_at=now() WHERE task_id=${task}`;
  await settleSendOutcome(sql, workspace, send, outcome);
}

/** The user asks to check an unconfirmed send again (from 피드): a fresh read-only check, attempts reset. */
export async function recheckSend(sql: Query, workspace: string, sendTask: string) {
  const send = (await sql`SELECT task_id FROM assistant.attention_source_sends WHERE workspace_id=${workspace} AND task_id=${sendTask} AND state IN ('needs_user','unknown') FOR UPDATE`)[0];
  if (!send) return false;
  await sql`UPDATE assistant.attention_source_sends SET state='unknown',check_attempts=0 WHERE task_id=${send['task_id']}`;
  await startSendCheck(sql, workspace, String(send['task_id']));
  return true;
}
/** The user confirms in Gmail what happened: sent (resolves the card) or not sent (the card may be approved again). */
export async function confirmSend(sql: Query, workspace: string, sendTask: string, sent: boolean) {
  const send = (await sql`SELECT * FROM assistant.attention_source_sends WHERE workspace_id=${workspace} AND task_id=${sendTask} AND state IN ('needs_user','unknown','checking') FOR UPDATE`)[0];
  if (!send) return false;
  const outcome = sent ? 'sent' : 'not_sent';
  await sql`UPDATE assistant.attention_source_sends SET state=${outcome},note=${sent ? 'the user confirmed it was sent' : 'the user confirmed it was not sent'},finished_at=now() WHERE task_id=${send['task_id']}`;
  await settleSendOutcome(sql, workspace, { ...send, note: sent ? 'the user confirmed it was sent' : 'the user confirmed it was not sent' }, outcome);
  return true;
}

/**
 * One item's thread for the feed: the adapter's last whole reading (per message) and the current reply draft, if any
 * (its approval card, so the feed can approve, edit or ask again in place).
 */
export async function itemThread(sql: Query, workspace: string, id: string) {
  const i = (await sql`SELECT i.once_until,s.enabled,i.id,i.subject,i.counterpart,i.url,i.state,i.version,i.reply_note,i.reply_request_id,i.reply_requested_at,i.thread_snapshot,i.thread_read_at,s.kind,s.account,
      coalesce(i.conversation_id,s.conversation_id) AS conversation_id FROM assistant.attention_source_items i JOIN assistant.attention_sources s ON s.id=i.source_id
    WHERE i.workspace_id=${workspace} AND i.id=${id}`)[0];
  if (!i) return null;
  // The draft of this thread version and of the current reply request only (an older one is never offered).
  const d = (await sql`SELECT d.state AS job,d.card_message_id,m.blocks,c.state AS card_state,c.approved_body,c.retry_ok,m.conversation_id
    FROM assistant.attention_source_drafts d LEFT JOIN assistant.messages m ON m.id=d.card_message_id
    LEFT JOIN assistant.card_states c ON c.workspace_id=d.workspace_id AND c.message_id=d.card_message_id
    WHERE d.workspace_id=${workspace} AND d.item_id=${id} AND d.version=${i['version']} AND d.reply_request_id IS NOT DISTINCT FROM ${i['reply_request_id'] ?? null}::uuid
      AND d.state IN ('dispatched','ready') ORDER BY d.created_at DESC LIMIT 1`)[0];
  // The user's reply request: queued until a draft job starts, preparing while it runs, ready with a card, failed after the attempts.
  const req = i['reply_request_id'] ? (await sql`SELECT
      count(*) FILTER (WHERE state='dispatched') AS running, count(*) FILTER (WHERE state='ready') AS ready, count(*) FILTER (WHERE state IN ('failed','expired')) AS failed,
      count(*) FILTER (WHERE state IN ('handled','not_needed')) AS done, bool_or(state='withdrawn') AS withdrawn
    FROM assistant.attention_source_drafts WHERE item_id=${id} AND reply_request_id=${i['reply_request_id']} AND version=${i['version']}`)[0] : null;
  // Ended states first: the thread was closed (handled here, in Gmail, or dismissed), the draft job found no reply
  // needed, or the one-off permission ran out before a draft was made.
  const expired = !i['enabled'] && (!i['once_until'] || new Date(String(i['once_until'])) <= new Date());
  const reqState = !req ? null : i['state'] !== 'open' || Number(req['done']) ? 'completed' : Number(req['ready']) ? 'ready' : Number(req['running']) ? 'preparing'
    : Number(req['failed']) >= 2 ? 'failed' : expired ? 'expired' : 'queued';
  const snap = i['thread_snapshot'] as { messages?: ThreadMessage[]; truncated?: boolean } | ThreadMessage[] | null;
  const messages = Array.isArray(snap) ? snap : snap?.messages ?? [];
  const block = d ? ((d['blocks'] as { kind: string; id: string; target: string | null; title: string | null; body: string }[] | null) ?? []).find(b => b.kind === 'draft') : undefined;
  return {
    id: String(i['id']), subject: String(i['subject']), counterpart: i['counterpart'] ? String(i['counterpart']) : null, url: i['url'] ? String(i['url']) : null,
    source: i['kind'] === 'slack' ? 'Slack' : 'Gmail', account: String(i['account']), open: i['state'] === 'open', reply_note: i['reply_note'] ? String(i['reply_note']) : null,
    messages: messages.map(m => ({ ...m, at: printTime(m.at) })), truncated: !Array.isArray(snap) && snap?.truncated === true,
    reply_request: i['reply_request_id'] && reqState ? { id: String(i['reply_request_id']), state: reqState, note: i['reply_note'] ? String(i['reply_note']) : null, at: new Date(String(i['reply_requested_at'])).toISOString() } : null,
    read_at: i['thread_read_at'] ? new Date(String(i['thread_read_at'])).toISOString() : null,
    draft: !d ? null : d['job'] === 'dispatched' || !block ? { preparing: true } : {
      preparing: false, conversation_id: String(d['conversation_id']), message_id: String(d['card_message_id']), block_id: block.id, target: block.target, title: block.title,
      body: d['approved_body'] ? String(d['approved_body']) : block.body, card_state: d['card_state'] ? String(d['card_state']) : 'pending', retry_ok: d['retry_ok'] === true },
  };
}

/** Is this the account of the source the task works for (a look or a draft job)? */
export async function taskSourceAccount(sql: Query, workspace: string, task: string, account: string | null) {
  if (!account) return false;
  const row = (await sql`SELECT s.account FROM assistant.attention_sources s WHERE s.workspace_id=${workspace} AND s.id IN (
      SELECT source_id FROM assistant.attention_source_runs WHERE task_id=${task} UNION SELECT source_id FROM assistant.attention_source_drafts WHERE task_id=${task})`)[0];
  return !!row && String(row['account']).toLowerCase() === account.toLowerCase();
}

/** The account a source job may read (its source), for the daemon to pin reader calls to. */
export async function sourceScope(sql: Query, workspace: string, task: string): Promise<{ kind: Kind; account: string } | null> {
  const row = (await sql`SELECT s.kind,s.account FROM assistant.attention_sources s WHERE s.workspace_id=${workspace} AND s.id IN (
      SELECT source_id FROM assistant.attention_source_runs WHERE task_id=${task} UNION SELECT source_id FROM assistant.attention_source_drafts WHERE task_id=${task})`)[0];
  return row ? { kind: row['kind'] as Kind, account: String(row['account']) } : null;
}

/** A due alert for this item that no longer holds stops notifying now (not at the next tick). */
async function withdrawAlertsFor(sql: Query, workspace: string, item: string) {
  const { withdrawStaleAlerts } = await import('./coordinator');
  await withdrawStaleAlerts(sql, workspace, new Date(), item);
}

/**
 * 다시 확인 on a blocked source (the user logged in): one look now, answered where the source was last asked for. A
 * stopped watch stays stopped; only this one look runs (the user's press is the request).
 */
export async function retrySource(sql: Query, workspace: string, id: string) {
  const s = (await sql`SELECT * FROM assistant.attention_sources WHERE workspace_id=${workspace} AND id=${id} AND health IN ('needs_user','degraded','retrying') FOR UPDATE`)[0];
  if (!s) return null;
  if ((await sql`SELECT 1 FROM assistant.attention_source_runs WHERE source_id=${id} AND state='dispatched'`)[0]) return 'already';
  const message = String(s['source_message_id']);
  const task = await startLook(sql, s, new Date(), { conversation: String(s['conversation_id']), message });
  await sql`UPDATE assistant.attention_sources SET health='retrying',updated_at=now() WHERE id=${id}`;
  return task;
}
