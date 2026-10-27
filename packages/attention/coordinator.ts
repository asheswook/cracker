/**
 * Attention coordinator: the assistant's own daily rhythm, run from the control cron every minute.
 * Code decides *when* and *whether* (local day, learned time, quiet hours, one brief per day, only when something is
 * new or still needs the user, expiry); the model decides *what* (it writes the brief from read_attention in a
 * background run). The brief's body is stored first and then exactly one push points at it (see publishBriefMessage).
 *
 * The brief time is learned from the user's own first activity of the day (median of recent weekdays' first user
 * message before today), moved early enough to arrive before it, clamped to 07:30–11:30 local and outside quiet hours,
 * and moved at most 30 minutes a day. An explicit time the user asked for wins, including over quiet hours.
 */
import { z } from 'zod';
import type { Database, Query } from '../../services/control/db';
import { createBackgroundTask } from '../../services/control/repository/common';
import { attention, type Attention } from './store';
import { markSourceItemsBriefed } from './sources';
import { enqueueMessageNotification } from '../notifications/store.ts';
import { publishMeetingPrep, tickMeetingPreps } from './meeting-prep';

const Settings = z.object({
  workspace_id: z.uuid(), timezone: z.string(), brief_enabled: z.boolean(), brief_at_minute: z.number().int().nullable(),
  quiet_start_minute: z.number().int(), quiet_end_minute: z.number().int(), updated_at: z.coerce.date(),
});
type Settings = z.infer<typeof Settings>;

export const BRIEF_OBJECTIVE = [
  'Morning brief (assistant-owned). Call read_attention first; since_last_brief lists what is new.',
  'Report only from read_attention (and today\'s calendar if you have it); do not open mail, Slack or the browser yourself — watched sources are read by their own looks.',
  'If today has meetings on the calendar, add a short "오늘 회의" part: each meeting as one line with its time, who is in it, and — only from read_attention items or prior work about the same people or subject — one thing worth knowing or asking before it. Skip meetings you know nothing useful about beyond the title; never invent context.',
  'After reading today\'s calendar, call plan_meeting_prep once with today\'s meetings that have attendees other than the user or a subject you have prior work on. Use the calendar event id as event_key (or title|start if none), the exact ISO starts_at, attendees, and a short note_hint from known work (may be empty). Do this even if the brief itself is NO_REPORT.',
  'If nothing needs the user and nothing in since_last_brief is worth telling, reply exactly NO_REPORT.',
  'Otherwise reply with the brief as your final report. Its first line is a one-line count summary like "확인할 것 2개, 진행 중 3개" (real numbers; name the most important item in a few words if it fits); that line becomes the notification.',
  'Then one line per item, needs-the-user first, by topic. Refer to existing cards by what they ask; do not create a new card for a decision that already has one. Do not call notify_user.',
  'State freshness honestly: if a watched source was not checked today, say so instead of implying all is well.',
  'Do not offer to set up new checks or re-enable anything; never re-offer what the user cancelled or dismissed (dismissed_offers).',
].join(' ');

/** How long a dispatched brief may take before a late body is no longer a morning brief. */
const BRIEF_TTL_MINUTES = 45;
/** Learned briefs are not sent after this local minute; an explicit time gets three hours of grace instead. */
const LEARNED_CUTOFF = 13 * 60;

function localMinute(date: Date, timezone: string) {
  const parts = new Intl.DateTimeFormat('en-GB', { timeZone: timezone, hour: '2-digit', minute: '2-digit', hourCycle: 'h23' }).formatToParts(date);
  return Number(parts.find(p => p.type === 'hour')?.value) * 60 + Number(parts.find(p => p.type === 'minute')?.value);
}
export function localDate(date: Date, timezone: string) {
  return new Intl.DateTimeFormat('en-CA', { timeZone: timezone, year: 'numeric', month: '2-digit', day: '2-digit' }).format(date);
}
const inQuiet = (minute: number, s: Pick<Settings, 'quiet_start_minute' | 'quiet_end_minute'>) => s.quiet_start_minute === s.quiet_end_minute ? false
  : s.quiet_start_minute < s.quiet_end_minute ? minute >= s.quiet_start_minute && minute < s.quiet_end_minute
  : minute >= s.quiet_start_minute || minute < s.quiet_end_minute;

/** The learned brief minute: ~40 minutes before the median first activity of recent weekdays, clamped and damped. */
export async function learnedBriefMinute(sql: Query, s: Pick<Settings, 'workspace_id' | 'timezone' | 'brief_at_minute' | 'quiet_start_minute' | 'quiet_end_minute'>, asOf = new Date()): Promise<{ minute: number; reason: string }> {
  if (s.brief_at_minute !== null) return { minute: s.brief_at_minute, reason: 'user_time' };
  const today = localDate(asOf, s.timezone);
  // First real user message per weekday before today: no QA probes, no card answers, no hidden or synthetic input.
  const rows = z.array(z.object({ first: z.coerce.number() })).parse(await sql`
    SELECT min(extract(hour FROM created_at AT TIME ZONE ${s.timezone})*60+extract(minute FROM created_at AT TIME ZONE ${s.timezone})) AS first
    FROM assistant.messages WHERE workspace_id=${s.workspace_id} AND role='user' AND origin='user' AND NOT synthetic AND NOT hidden
      AND content !~* '^\\s*QA' AND NOT coalesce(blocks @> '[{"kind":"answer"}]', false)
      AND created_at>${asOf}::timestamptz-interval '28 days' AND (created_at AT TIME ZONE ${s.timezone})::date<${today}::date
      AND extract(isodow FROM created_at AT TIME ZONE ${s.timezone}) BETWEEN 1 AND 5
      AND extract(hour FROM created_at AT TIME ZONE ${s.timezone}) BETWEEN 6 AND 15
    GROUP BY (created_at AT TIME ZONE ${s.timezone})::date`);
  let minute = 9 * 60, reason = 'default';
  if (rows.length >= 5) {
    const sorted = rows.map(r => r.first).sort((a, b) => a - b);
    const median = sorted[Math.floor(sorted.length / 2)] ?? 9 * 60;
    minute = Math.min(11 * 60 + 30, Math.max(7 * 60 + 30, Math.round((median - 40) / 5) * 5));
    reason = `learned:${sorted.length}d:median=${median}`;
  }
  // Damping: a few odd days must not swing the brief by hours. Move at most 30 minutes from the last learned time.
  const last = (await sql`SELECT planned_minute FROM assistant.attention_briefs WHERE workspace_id=${s.workspace_id} AND local_date<${today}::date
    AND reason NOT LIKE 'user_time%' ORDER BY local_date DESC LIMIT 1`)[0];
  if (last) { const prev = Number(last['planned_minute']); minute = Math.min(prev + 30, Math.max(prev - 30, minute)); }
  while (inQuiet(minute, s) && minute < 12 * 60) minute += 15;
  return { minute, reason };
}

/** What a brief covered, so the next one can tell what is new. Standing watches are not news by themselves. */
type Snapshot = { needs: string[]; work: string[]; done: string[] };
export function briefSnapshot(view: Attention): Snapshot {
  const key = (i: { id: string; state: string | null; version?: string | null }) => `${i.id}:${i.state ?? ''}${i.version ? `@${i.version}` : ''}`;
  return {
    needs: view.needs_you.map(key),
    work: view.in_progress.filter(i => i.kind === 'card' || i.kind === 'task' || i.kind === 'mail').map(key),
    done: view.done.map(i => i.id),
  };
}
/** What changed since the last delivered brief. Open decisions are always worth a line; watches alone never are. */
export function briefChanges(now: Snapshot, last: Snapshot | null) {
  const seen = (list: string[] | undefined) => new Set(list ?? []);
  const lastWork = seen(last?.work), lastDone = seen(last?.done);
  const lastNeeds = seen(last?.needs);
  // Decisions (cards) always count; a mail thread or watch counts only when new or changed since the last brief.
  const fresh = (k: string) => !(k.startsWith('mail:') || k.startsWith('watch:')) || !lastNeeds.has(k);
  return {
    needs_you: now.needs.filter(fresh).length,
    new_work: now.work.filter(k => !lastWork.has(k)).length,
    new_done: now.done.filter(k => !lastDone.has(k)).length,
  };
}
const worthBriefing = (c: ReturnType<typeof briefChanges>) => c.needs_you > 0 || c.new_work > 0 || c.new_done > 0;

/** News is kept until a brief delivers it: done items since the last delivered brief (at most 7 days), not a 48h window. */
async function doneSince(sql: Query, workspace: string, before: string, now: Date): Promise<Date> {
  // From the last delivered brief's input cut-off (what it read), not its publication time.
  const row = (await sql`SELECT coalesce(snapshot_at,finished_at) AS at FROM assistant.attention_briefs WHERE workspace_id=${workspace} AND local_date<${before}::date AND state='delivered' ORDER BY local_date DESC LIMIT 1`)[0];
  const floor = new Date(now.getTime() - 7 * 86_400_000);
  if (!row?.['at']) return new Date(now.getTime() - 2 * 86_400_000);
  const at = new Date(String(row['at']));
  return at < floor ? floor : at;
}
export async function briefView(sql: Query, workspace: string, day: string, now = new Date()) {
  return attention(sql, workspace, { doneSince: await doneSince(sql, workspace, day, now) });
}

async function lastSnapshot(sql: Query, workspace: string, before: string): Promise<Snapshot | null> {
  const row = (await sql`SELECT snapshot FROM assistant.attention_briefs WHERE workspace_id=${workspace} AND local_date<${before}::date AND state='delivered' AND snapshot IS NOT NULL ORDER BY local_date DESC LIMIT 1`)[0];
  return row ? z.object({ needs: z.array(z.string()), work: z.array(z.string()), done: z.array(z.string()) }).parse(row['snapshot']) : null;
}

/**
 * read_attention for a brief run: the view (news since the last delivered brief, without brief runs) plus what is new.
 * What the run read is recorded as the brief's snapshot, so "delivered" means exactly what the body was written from.
 */
export async function briefContext(sql: Query, workspace: string, task: string) {
  const brief = (await sql`SELECT local_date::text AS day,state FROM assistant.attention_briefs WHERE workspace_id=${workspace} AND task_id=${task}`)[0];
  if (!brief) return null;
  const view = await briefView(sql, workspace, String(brief['day']));
  if (brief['state'] === 'dispatched') await sql`UPDATE assistant.attention_briefs SET snapshot=${JSON.stringify(briefSnapshot(view))}::text::jsonb,snapshot_at=now() WHERE workspace_id=${workspace} AND task_id=${task} AND state='dispatched'`;
  const current = briefSnapshot(view), last = await lastSnapshot(sql, workspace, String(brief['day']));
  const lastWork = new Set(last?.work ?? []), lastDone = new Set(last?.done ?? []), lastNeeds = new Set(last?.needs ?? []);
  return { view, since_last_brief: {
    first_brief: last === null,
    new_needs_you: view.needs_you.filter(i => !lastNeeds.has(`${i.id}:${i.state ?? ''}${i.version ? `@${i.version}` : ''}`)).map(i => i.id),
    new_in_progress: view.in_progress.filter(i => (i.kind === 'card' || i.kind === 'task' || i.kind === 'mail') && !lastWork.has(`${i.id}:${i.state ?? ''}${i.version ? `@${i.version}` : ''}`)).map(i => i.id),
    new_done: view.done.filter(i => !lastDone.has(i.id)).map(i => i.id),
  } };
}

async function tickWorkspace(sql: Database, workspace: string, now: Date) {
  return sql.begin(async tx => {
    // The settings row lock serializes this tick with set_brief and with a concurrent cron invocation.
    const row = (await tx`SELECT workspace_id,timezone,brief_enabled,brief_at_minute,quiet_start_minute,quiet_end_minute,updated_at FROM assistant.attention_settings WHERE workspace_id=${workspace} FOR UPDATE SKIP LOCKED`)[0];
    if (!row) return 'busy';
    const s = Settings.parse(row);
    const today = localDate(now, s.timezone), minuteNow = localMinute(now, s.timezone);
    // A dispatched brief that never came back is expired, so its late body is not published.
    const expired = await tx`UPDATE assistant.attention_briefs SET state='expired',finished_at=${now} WHERE workspace_id=${workspace} AND state='dispatched' AND expires_at<=${now} RETURNING task_id`;
    for (const e of expired) await cancelQueuedBrief(tx, String(e['task_id']));
    if (!s.brief_enabled) return 'off';
    let brief = (await tx`SELECT state,planned_at,planned_minute,reason,settings_at FROM assistant.attention_briefs WHERE workspace_id=${workspace} AND local_date=${today}::date`)[0];
    if (brief && brief['state'] === 'planned' && new Date(String(brief['settings_at'])).getTime() !== s.updated_at.getTime()) {
      await tx`DELETE FROM assistant.attention_briefs WHERE workspace_id=${workspace} AND local_date=${today}::date AND state='planned'`;
      brief = undefined;
    }
    if (!brief) {
      const { minute, reason } = await learnedBriefMinute(tx, s, now);
      const plannedAt = z.object({ at: z.coerce.date() }).parse((await tx`SELECT ((${today}::date + make_interval(mins=>${minute})) AT TIME ZONE ${s.timezone}) AS at`)[0]).at;
      // Planned after the time already passed (deploy, or the user just changed it): no brief today.
      const late = minuteNow > minute + 10;
      const inserted = await tx`INSERT INTO assistant.attention_briefs(workspace_id,local_date,state,planned_at,planned_minute,reason,settings_at,finished_at)
        VALUES(${workspace},${today}::date,${late ? 'skipped' : 'planned'},${plannedAt},${minute},${late ? `${reason} past` : reason},${s.updated_at},${late ? now : null})
        ON CONFLICT DO NOTHING RETURNING state`;
      if (!inserted[0]) return 'raced';
      if (late) return 'skipped';
      brief = { state: 'planned', planned_at: plannedAt, planned_minute: minute, reason };
    }
    if (brief['state'] !== 'planned' || new Date(String(brief['planned_at'])) > now) return brief['state'] === 'planned' ? 'planned' : 'done';
    const explicit = String(brief['reason']).startsWith('user_time');
    const cutoff = explicit ? Number(brief['planned_minute']) + 180 : LEARNED_CUTOFF;
    if (minuteNow > cutoff || (!explicit && inQuiet(minuteNow, s))) {
      await tx`UPDATE assistant.attention_briefs SET state='skipped',reason=reason||' late',finished_at=${now} WHERE workspace_id=${workspace} AND local_date=${today}::date`;
      return 'skipped';
    }
    // Cards put off "until the next brief" come back with this one.
    await tx`UPDATE assistant.card_states SET state='pending',snoozed_until=NULL,snooze_next_brief=false,updated_at=now() WHERE workspace_id=${workspace} AND state='snoozed' AND snooze_next_brief`;
    const view = await briefView(tx, workspace, today, now);
    const snapshot = briefSnapshot(view);
    const changes = briefChanges(snapshot, await lastSnapshot(tx, workspace, today));
    // Weekends: only a decision waiting for the user is worth a morning push; news waits for Monday.
    const weekend = [0, 6].includes(new Date(`${today}T12:00:00Z`).getUTCDay());
    if (weekend ? changes.needs_you === 0 : !worthBriefing(changes)) {
      await tx`UPDATE assistant.attention_briefs SET state='skipped',reason=reason||' unchanged',snapshot=${JSON.stringify(snapshot)}::text::jsonb,finished_at=${now} WHERE workspace_id=${workspace} AND local_date=${today}::date`;
      return 'skipped';
    }
    const conversation = z.object({ id: z.uuid().nullable() }).parse((await tx`SELECT default_conversation_id AS id FROM assistant.workspaces WHERE id=${workspace}`)[0]).id;
    if (!conversation) return 'no_conversation';
    const created = await createBackgroundTask(tx, { workspace, conversation, objective: BRIEF_OBJECTIVE, title: '아침 브리핑', origin: 'responsibility', clientId: await briefClientId(workspace, `${today}:${s.updated_at.toISOString()}`) });
    await tx`INSERT INTO assistant.attention_brief_runs(task_id,workspace_id,local_date) VALUES(${created.task.id},${workspace},${today}::date) ON CONFLICT DO NOTHING`;
    await tx`UPDATE assistant.attention_briefs SET state='dispatched',task_id=${created.task.id},dispatched_at=${now},expires_at=${now}::timestamptz+${BRIEF_TTL_MINUTES}*interval '1 minute',
      snapshot=${JSON.stringify(snapshot)}::text::jsonb WHERE workspace_id=${workspace} AND local_date=${today}::date`;
    return 'dispatched';
  });
}

/** Plan today's brief if not planned yet, and dispatch it when due. Each workspace is isolated: one failure does not stop the others. */
/**
 * "It can't wait for the next brief": a watched item that needs the user and is due before the next brief (or just
 * went past due) gets one short alert in its conversation, once per item, request and stage. Code decides and writes
 * the line from the item; nothing is sent in quiet hours, for a stopped watch, or for something already handled.
 */
export async function alertDueItems(sql: Query, workspace: string, now = new Date()) {
  await withdrawStaleAlerts(sql, workspace, now);
  const next = await upcomingBrief(sql, workspace, now);
  const quiet = (await sql`SELECT quiet_start_minute AS qs,quiet_end_minute AS qe,timezone FROM assistant.attention_settings WHERE workspace_id=${workspace}`)[0];
  if (quiet) {
    const minute = localMinute(now, String(quiet['timezone'])), qs = Number(quiet['qs']), qe = Number(quiet['qe']);
    if (qs !== qe && (qs > qe ? minute >= qs || minute < qe : minute >= qs && minute < qe)) return 0;
  }
  // A brief being written right now will carry what is due; it speaks for those items unless it fails.
  if (next.inFlight) return 0;
  const candidates = await sql`SELECT i.id FROM assistant.attention_source_items i JOIN assistant.attention_sources s ON s.id=i.source_id
    WHERE i.workspace_id=${workspace} AND i.state='open' AND i.action<>'none' AND i.category<>'waiting' AND i.due_at IS NOT NULL
      AND (s.enabled OR i.once_until>${now}) AND i.due_at<${next.at} AND i.due_at>${now}::timestamptz-interval '1 day'`;
  let sent = 0;
  for (const c of candidates) {
    // Re-read under the item's lock: handled, rescheduled or stopped since the scan means no alert.
    const i = (await sql`SELECT i.id,i.subject,i.counterpart,i.category,i.reason,i.due_at,coalesce(i.conversation_id,s.conversation_id) AS conversation_id
      FROM assistant.attention_source_items i JOIN assistant.attention_sources s ON s.id=i.source_id
      WHERE i.id=${String(c['id'])} AND i.state='open' AND i.action<>'none' AND i.category<>'waiting' AND i.due_at IS NOT NULL AND (s.enabled OR i.once_until>${now})
        AND i.due_at<${next.at} AND i.due_at>${now}::timestamptz-interval '1 day'
        -- Blocked (the user said why it cannot move): only once it is actually past due.
        AND (i.blocked_reason IS NULL OR i.due_at<=${now})
        -- Not while a reply is being sent or its result is unknown, and not while the user put the draft off.
        AND NOT EXISTS(SELECT 1 FROM assistant.attention_source_sends e WHERE e.item_id=i.id AND e.state IN ('dispatched','executing','unknown','checking','needs_user'))
        AND NOT EXISTS(SELECT 1 FROM assistant.attention_source_drafts d JOIN assistant.card_states k ON k.message_id=d.card_message_id
          WHERE d.item_id=i.id AND k.state='snoozed' AND (k.snooze_next_brief OR k.snoozed_until>${now}))
      FOR UPDATE OF i`)[0];
    if (!i) continue;
    const stage = new Date(String(i['due_at'])) <= now ? 'overdue' : 'before_brief';
    // One alert per obligation (its kind), due date and stage.
    const claimed = await sql`INSERT INTO assistant.attention_due_alerts(workspace_id,item_id,anchor,obligation,due_at,stage) VALUES(${workspace},${String(i['id'])},'',${String(i['category'])},${String(i['due_at'])},${stage}) ON CONFLICT DO NOTHING RETURNING item_id`;
    if (!claimed.length) {
      // Already alerted for this. If that alert was withdrawn before it reached the user (blocked, then unblocked), it
      // counts again: its message notifies again and its push is queued again; one that was delivered stays done.
      const back = await sql`UPDATE assistant.messages m SET notify=true FROM assistant.attention_due_alerts a
        WHERE a.item_id=${String(i['id'])} AND a.obligation=${String(i['category'])} AND a.due_at=${String(i['due_at'])} AND a.stage=${stage} AND m.id=a.message_id AND NOT m.notify
          AND NOT EXISTS(SELECT 1 FROM assistant.notification_deliveries d WHERE d.intent_id=m.id AND d.state='accepted') RETURNING m.id`;
      for (const b of back) {
        await sql`UPDATE assistant.notification_deliveries SET state='pending',next_attempt_at=now(),last_error=NULL WHERE intent_id=${b['id']} AND state='suppressed' AND last_error='withdrawn'`;
        sent++;
      }
      continue;
    }
    const due = new Intl.DateTimeFormat('ko-KR', { timeZone: quiet ? String(quiet['timezone']) : 'Asia/Seoul', month: 'numeric', day: 'numeric', weekday: 'short', hour: 'numeric', minute: '2-digit' }).format(new Date(String(i['due_at'])));
    const who = i['counterpart'] ? String(i['counterpart']).replace(/\s*[<(].*$/, '').trim() : null;
    const what = i['category'] === 'promise' ? `${who ? `${who}님께 ` : ''}약속한 일` : `${who ? `${who}님 ` : ''}메일`;
    const line = stage === 'overdue' ? `${what}의 기한(${due})이 지났어요: ${String(i['subject']).slice(0, 60)}. ${String(i['reason']).slice(0, 80)}`
      : `${what}이 ${due}까지예요. 다음 브리핑 전이라 먼저 알려 드려요: ${String(i['subject']).slice(0, 60)}`;
    const msg = (await sql`INSERT INTO assistant.messages(workspace_id,conversation_id,role,content,origin,notify)
      VALUES(${workspace},${String(i['conversation_id'])},'assistant',${line},'responsibility',true) RETURNING id`)[0]!;
    await sql`UPDATE assistant.attention_due_alerts SET message_id=${msg['id']} WHERE item_id=${String(i['id'])} AND obligation=${String(i['category'])} AND due_at=${String(i['due_at'])} AND stage=${stage}`;
    await sql`WITH e AS (INSERT INTO assistant.events(workspace_id,kind,payload) VALUES(${workspace},'message.created',${JSON.stringify({ message: { id: msg['id'] } })}::text::jsonb) RETURNING id) INSERT INTO assistant.outbox(workspace_id,event_id) SELECT ${workspace},id FROM e`;
    await enqueueMessageNotification(sql, workspace, { id: String(msg['id']) });
    sent++;
  }
  return sent;
}
/**
 * Alerts whose item was handled, rescheduled, blocked, re-labelled or whose watch stopped: their message stops
 * notifying, which also drops a push still waiting in the queue. Called when such a change happens and on every tick.
 */
export async function withdrawStaleAlerts(sql: Query, workspace: string, now = new Date(), item: string | null = null) {
  await sql`UPDATE assistant.messages m SET notify=false FROM assistant.attention_due_alerts a
    JOIN assistant.attention_source_items i ON i.id=a.item_id JOIN assistant.attention_sources s ON s.id=i.source_id
    WHERE a.workspace_id=${workspace} AND (${item}::uuid IS NULL OR a.item_id=${item}::uuid) AND m.id=a.message_id AND m.notify AND a.created_at>${now}::timestamptz-interval '1 day'
      AND (i.state<>'open' OR i.due_at IS DISTINCT FROM a.due_at OR i.category<>a.obligation OR (i.blocked_reason IS NOT NULL AND i.due_at>${now}) OR (s.enabled OR i.once_until>${now}) IS NOT TRUE)`;
}
/**
 * When the next brief will speak, for due alerts: a brief being written now (in flight), today's planned one while still
 * ahead, else tomorrow's. With briefs off there is none (alerts cover the next 24 hours).
 */
async function upcomingBrief(sql: Query, workspace: string, now: Date): Promise<{ at: Date; inFlight: boolean }> {
  const s = (await sql`SELECT brief_enabled FROM assistant.attention_settings WHERE workspace_id=${workspace}`)[0];
  if (s && s['brief_enabled'] === false) return { at: new Date(now.getTime() + 86_400_000), inFlight: false };
  const flight = (await sql`SELECT 1 FROM assistant.attention_briefs WHERE workspace_id=${workspace} AND state='dispatched' AND expires_at>${now}`)[0];
  return { at: await nextBriefAt(sql, workspace, now), inFlight: !!flight };
}
export async function tickAttention(sql: Database, now = new Date()): Promise<Record<string, number>> {
  await sql`INSERT INTO assistant.attention_settings(workspace_id) SELECT id FROM assistant.workspaces WHERE default_conversation_id IS NOT NULL ON CONFLICT DO NOTHING`;
  const workspaces = (await sql`SELECT workspace_id FROM assistant.attention_settings`).map(r => String(r['workspace_id']));
  // Most workspaces have no preparations. Only enter a dispatch transaction when a row could be due or stale.
  const prepWorkspaces = new Set((await sql`SELECT DISTINCT workspace_id FROM assistant.meeting_preps
    WHERE state='planned' AND starts_at<=${now}::timestamptz+interval '12 minutes'`).map(r => String(r['workspace_id'])));
  const counts: Record<string, number> = {};
  for (const workspace of workspaces) {
    let outcome: string;
    try {
      const preps = prepWorkspaces.has(workspace) ? await tickMeetingPreps(sql, workspace, now) : 0;
      if (preps) counts['meeting_preps'] = (counts['meeting_preps'] ?? 0) + preps;
      outcome = await tickWorkspace(sql, workspace, now);
      // Only workspaces with an open item that has a due date (most have none).
      const dueSoon = (await sql`SELECT 1 FROM assistant.attention_source_items WHERE workspace_id=${workspace} AND state='open' AND due_at IS NOT NULL LIMIT 1`).length > 0
        || (await sql`SELECT 1 FROM assistant.attention_due_alerts WHERE workspace_id=${workspace} AND created_at>now()-interval '1 day' LIMIT 1`).length > 0;
      const alerted = dueSoon ? await sql.begin(tx => alertDueItems(tx, workspace, now)) : 0;
      if (alerted) counts['due_alerts'] = (counts['due_alerts'] ?? 0) + alerted;
    }
    catch (error) {
      if (!(error instanceof Error)) throw error;
      console.error(JSON.stringify({ event: 'attention.workspace_failed', workspace, type: error.name, message: error.message.slice(0, 200) }));
      outcome = 'error';
    }
    counts[outcome] = (counts[outcome] ?? 0) + 1;
  }
  return counts;
}

/**
 * Called when a brief run stores a message. The final report is the brief: it is published only while the brief is
 * still dispatched and not expired, gets notify=true (a normal message, not folded into the run row) and one push.
 * Returns how the caller must store the message: { hidden, notify, push }.
 */
export async function publishBriefMessage(sql: Query, workspace: string, task: string, message: { readonly final: boolean; readonly empty: boolean }) {
  const prep = await publishMeetingPrep(sql, workspace, task, message);
  if (prep) return prep;
  if (!(await isBriefTask(sql, workspace, task))) return null;
  // The brief row is the publication right: set_brief (off / new time) removes it, expiry ends it. Any output of a
  // brief run without a live row is dropped, whatever its kind.
  const brief = (await sql`SELECT state,expires_at FROM assistant.attention_briefs WHERE workspace_id=${workspace} AND task_id=${task} FOR UPDATE`)[0];
  const live = brief?.['state'] === 'dispatched' && new Date(String(brief['expires_at'])) > new Date();
  if (!live) {
    if (brief?.['state'] === 'dispatched') await sql`UPDATE assistant.attention_briefs SET state='expired',finished_at=now() WHERE workspace_id=${workspace} AND task_id=${task}`;
    return { hidden: true, notify: false, push: false };
  }
  // Cards and progress inside a brief never push on their own; the brief's single push covers them.
  if (!message.final) return { hidden: null, notify: null, push: false };
  if (message.empty) {
    await sql`UPDATE assistant.attention_briefs SET state='skipped',reason=reason||' no_report',finished_at=now() WHERE workspace_id=${workspace} AND task_id=${task}`;
    return { hidden: true, notify: false, push: false };
  }
  return { hidden: false, notify: true, push: true };
}
export async function markBriefDelivered(sql: Query, workspace: string, task: string, messageId: string) {
  await sql`UPDATE assistant.meeting_preps SET state='done' WHERE workspace_id=${workspace} AND task_id=${task} AND state='dispatched'`;
  const rows = await sql`UPDATE assistant.attention_briefs SET state='delivered',message_id=${messageId},finished_at=now() WHERE workspace_id=${workspace} AND task_id=${task} AND state='dispatched' RETURNING snapshot`;
  // Exactly what the body was written from is no longer news.
  const snap = rows[0]?.['snapshot'] as { needs?: string[] } | null | undefined;
  if (snap?.needs) await markSourceItemsBriefed(sql, workspace, snap.needs);
}
export async function isBriefTask(sql: Query, workspace: string, task: string) {
  return !!(await sql`SELECT 1 FROM assistant.attention_brief_runs WHERE workspace_id=${workspace} AND task_id=${task}
    UNION ALL SELECT 1 FROM assistant.meeting_preps WHERE workspace_id=${workspace} AND task_id=${task} LIMIT 1`)[0];
}
async function cancelQueuedBrief(sql: Query, task: string) {
  await sql`UPDATE assistant.tasks SET state='cancelled',reason='Morning brief expired or superseded before it ran',updated_at=now() WHERE id=${task} AND state='queued' AND lane='background'`;
}
/**
 * The user changed the brief (set_brief): today's brief that has not been delivered is withdrawn — a planned or skipped
 * one is re-planned by the next tick, a running one loses its right to publish and its queued task is cancelled.
 * Call with the settings row locked.
 */
export async function withdrawBrief(sql: Query, workspace: string) {
  const rows = await sql`DELETE FROM assistant.attention_briefs WHERE workspace_id=${workspace} AND state IN ('planned','skipped','dispatched','expired','failed')
    AND local_date>=(now() AT TIME ZONE (SELECT timezone FROM assistant.attention_settings WHERE workspace_id=${workspace}))::date-1 RETURNING task_id`;
  for (const r of rows) if (r['task_id']) await cancelQueuedBrief(sql, String(r['task_id']));
}
/** The brief run ended without publishing a body. */
export async function settleBriefForTask(sql: Query, workspace: string, task: string, state: string) {
  if (!['succeeded', 'failed', 'cancelled'].includes(state)) return;
  await sql`UPDATE assistant.meeting_preps SET state='skipped' WHERE workspace_id=${workspace} AND task_id=${task} AND state='dispatched'`;
  await sql`UPDATE assistant.attention_briefs SET state=${state === 'succeeded' ? 'skipped' : 'failed'},reason=reason||${state === 'succeeded' ? ' no_body' : ` ${state}`},finished_at=now()
    WHERE workspace_id=${workspace} AND task_id=${task} AND state='dispatched'`;
}
/** When the user's next brief is expected (for "나중에": a snoozed card comes back with the next brief). */
export async function nextBriefAt(sql: Query, workspace: string, now = new Date()): Promise<Date> {
  const planned = (await sql`SELECT planned_at FROM assistant.attention_briefs WHERE workspace_id=${workspace} AND state='planned' AND planned_at>${now} ORDER BY planned_at LIMIT 1`)[0];
  if (planned) return new Date(String(planned['planned_at']));
  const s = (await sql`SELECT timezone,brief_at_minute FROM assistant.attention_settings WHERE workspace_id=${workspace}`)[0];
  const timezone = s ? String(s['timezone']) : 'Asia/Seoul';
  const last = (await sql`SELECT planned_minute FROM assistant.attention_briefs WHERE workspace_id=${workspace} ORDER BY local_date DESC LIMIT 1`)[0];
  const minute = s?.['brief_at_minute'] != null ? Number(s['brief_at_minute']) : last ? Number(last['planned_minute']) : 9 * 60;
  const today = localDate(now, timezone);
  // Today's time if it is still ahead and today's brief has not gone out; otherwise tomorrow's.
  const done = (await sql`SELECT 1 FROM assistant.attention_briefs WHERE workspace_id=${workspace} AND local_date=${today}::date AND state<>'planned'`)[0];
  const at = (day: number) => sql`SELECT (((${today}::date + ${day}::int) + make_interval(mins=>${minute})) AT TIME ZONE ${timezone}) AS at`;
  const todayAt = z.object({ at: z.coerce.date() }).parse((await at(0))[0]).at;
  if (!done && todayAt > now) return todayAt;
  return z.object({ at: z.coerce.date() }).parse((await at(1))[0]).at;
}

/** Deterministic wake id per workspace and day, so a retried tick reuses the same background task. */
export async function briefClientId(workspace: string, day: string): Promise<string> {
  const digest = new Uint8Array(await crypto.subtle.digest('SHA-256', new TextEncoder().encode(`brief:${workspace}:${day}`)));
  const hex = Array.from(digest, b => b.toString(16).padStart(2, '0')).join('');
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-4${hex.slice(13, 16)}-a${hex.slice(17, 20)}-${hex.slice(20, 32)}`;
}
