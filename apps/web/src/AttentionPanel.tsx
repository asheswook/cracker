import { useState } from 'react';
import {
  CalendarCheck, CalendarClock, ChevronDown, ChevronRight, CircleAlert, CircleCheck, CircleHelp, ListChecks, LogIn, Mail, MailCheck,
  MessageSquare, Pencil, Send, Sunrise, Trash2, type LucideIcon,
} from 'lucide-react';
import { http, errorMessage } from './api';
import { ErrorNotice } from './primitives';
import { DAY, FeedThread, relative, startOfDay } from './FeedThread';
import { automated, dropAttention, refreshAttention, setAttentionError, useAttention, type Item } from './attention-feed';
import './attention.css';

const dayName = new Intl.DateTimeFormat('ko-KR', { month: 'long', day: 'numeric' });
const dayNameYear = new Intl.DateTimeFormat('ko-KR', { year: 'numeric', month: 'long', day: 'numeric' });
export const briefLabel = (at: string, now = new Date()) => `${startOfDay(new Date(at)) === startOfDay(now) ? '오늘 아침 브리핑' : '최근 브리핑'} · ${relative(at, now)}`;

/** The detail worth a line: what the user must do (a login), or the item's own detail. No freshness, retries or how-tos. */
const detail = (item: Item): string | null => {
  if (!item.detail) return null;
  if (item.detail.startsWith('login:')) return item.detail.slice(6);
  if (/^(degraded|partial|checked|next):/.test(item.detail)) return null;
  if (item.state === 'stopped' || /^Runtime\/provider\/tool failure/.test(item.detail)) return null;
  return item.detail;
};

/** 님 for a person's name, nothing for an organisation-looking sender (e.g. "GitLab Security Bot"). */
const honorific = (who: string) => /[가-힣]/.test(who) && !/[A-Za-z]{3,}/.test(who) ? `${who}님` : who;
/** The particle after a word (이/가): by the last syllable's final consonant; for Latin text, "이". */
const subj = (w: string) => { const c = w.charCodeAt(w.length - 1) - 0xac00; return c >= 0 && c < 11172 ? (c % 28 ? '이' : '가') : '이'; };
/** With a sender or place: "Alex님이 메일로 요청했어요", "Gmail로 Alex님에게 답장을 보냈어요". */
const personal = (item: Item): string | null => {
  const who = item.who ? honorific(item.who) : null, src = item.source;
  // A review or a task named for what it asks, not as "a mail with a deadline".
  if (item.kind === 'mail' && who && item.action === 'review' && item.state !== 'promise') return `${who}${subj(who)} 리뷰를 요청했어요`;
  if (item.kind === 'mail' && who && item.action === 'reply' && item.state === 'deadline') return `${who}${subj(who)} 기한 안에 답을 기다려요`;
  if (item.kind === 'mail' && who && item.state === 'promise' && item.blocked) return `${who}에게 약속한 일이 막혀 있어요`;
  if (item.kind === 'mail' && who && item.state === 'chase') {
    const days = item.waiting_since ? Math.max(1, Math.floor((Date.now() - Date.parse(item.waiting_since)) / 86_400_000)) : null;
    return `${who} 회신이 ${days ? `${days}일째 ` : ''}없어요`;
  }
  if (item.kind === 'mail' && who) return ({ request: `${who}${subj(who)} ${src === 'Slack' ? 'Slack에서' : '메일로'} 요청했어요`, deadline: `${who}${subj(who)} 보낸 메일에 기한이 있어요`, promise: Date.parse(item.at) - Date.now() < 2 * 86_400_000 ? `${who}에게 약속한 기한이 다가와요` : `${who}에게 약속한 일이 있어요`, overdue: `${who}${subj(who)} 보낸 메일 기한이 지났어요`,
    waiting: `${who}의 회신을 기다리고 있어요`, alert: `${who}${subj(who)} 알림을 보냈어요` } as Record<string, string>)[item.state ?? ''] ?? `${who}${subj(who)} ${src === 'Slack' ? 'Slack에' : '메일을'} 보냈어요`;
  if (item.kind === 'mail' && item.state === 'handled' && src) return `${src}에서 처리된 걸 확인했어요`;
  if (item.kind === 'send' && who) return `${who}에게 보낸 답장이 나갔는지 확인해 주세요`;
  if (item.kind === 'result' && src) return ({ sent: `${who ? `${who}에게 ` : ''}${src} 답장을 보냈어요`, posted: `${src}에 게시했어요`, booked: `${src}에서 예약했어요`, scheduled: `${src}에 일정을 등록했어요` } as Record<string, string>)[item.state ?? ''] ?? null;
  if (item.kind === 'watch' && src) return `${src}에 다시 로그인해 주세요`;
  return null;
};
/** What happened, or what is needed, as a short sentence. Falls back to the status label. */
const headline = (item: Item): string => {
  const own = personal(item);
  if (own) return own;
  const s = item.state ?? '';
  const table: Partial<Record<Item['kind'], Record<string, string>>> = {
    card: { draft: '보낼지 확인해 주세요', choice: '하나 골라 주세요', accepted: '승인한 일을 처리하고 있어요', accepted_stalled: '승인한 일이 멈춰서 살펴보고 있어요', resolved: '승인한 일을 마쳤어요', failed: '승인한 일을 처리하지 못했어요', '': '확인해 주세요' },
    task: { stopped: '맡긴 일을 끝내지 못했어요', '': '맡긴 일을 하고 있어요' },
    send: { '': '답장이 나갔는지 확인해 주세요' },
    mail: { request: '메일로 요청이 왔어요', deadline: '기한이 있는 메일이에요', promise: '내가 약속한 기한이 있어요', overdue: '메일 기한이 지났어요', waiting: '메일 회신을 기다리고 있어요', alert: '메일 알림이 왔어요', '': '챙겨 볼 메일이 왔어요' },
    watch: { '': '다시 로그인해 주세요' },
    result: { sent: '보냈어요', posted: '게시했어요', scheduled: '일정을 등록했어요', booked: '예약했어요', updated: '바꿨어요', deleted: '삭제했어요', created: '만들었어요', '': '끝냈어요' },
  };
  const row = table[item.kind];
  return row?.[s] ?? row?.[''] ?? '확인해 주세요';
};

const glyph = (item: Item): LucideIcon => {
  if (item.kind === 'mail') return Mail;
  if (item.kind === 'send') return MailCheck;
  if (item.kind === 'card') return item.state === 'failed' ? CircleAlert : item.state === 'resolved' ? CircleCheck : CircleHelp;
  if (item.kind === 'task') return item.state === 'stopped' ? CircleAlert : ListChecks;
  if (item.kind === 'watch') return LogIn;
  if (item.kind === 'schedule') return CalendarClock;
  return ({ sent: Send, posted: MessageSquare, scheduled: CalendarCheck, booked: CalendarCheck, updated: Pencil, deleted: Trash2 } as Record<string, LucideIcon>)[item.state ?? ''] ?? CircleCheck;
};

const dayLabel = (day: number, now: Date): string => {
  const days = Math.round((startOfDay(now) - day) / DAY);
  if (days === 0) return '오늘';
  if (days === 1) return '어제';
  const d = new Date(day);
  return (d.getFullYear() === now.getFullYear() ? dayName : dayNameYear).format(d);
};

const newestFirst = (a: Item, b: Item) => new Date(b.at).getTime() - new Date(a.at).getTime();
const draftReady = (item: Item) => item.kind === 'mail' && !!item.detail?.includes('답장 초안 준비됨');
const PINNED_PREVIEW = 5;
const TIMELINE_PREVIEW = 20;

/** The assistant speaking: the headline, plus what it has already prepared. */
const sentence = (item: Item) => {
  const line = headline(item);
  return draftReady(item) ? `${line}. 답장 초안 써 뒀어요` : line;
};
/** The muted line: when, where, and the item's own detail — never the assistant's bookkeeping (draft or send states). */
const meta = (item: Item, now: Date) => {
  if (item.blocked) return ['막힘', item.blocked].join(' · ');
  const note = detail(item);
  const parts = item.kind === 'mail' && note
    ? note.split(' · ').filter(p => (!item.who || !p.includes(item.who)) && !/^(답장|초안|원문에서)/.test(p))
    : note && item.kind !== 'send' ? [note] : [];
  return [item.kind === 'watch' ? null : relative(item.at, now), item.source && item.kind !== 'watch' ? item.source : null, item.topic, ...parts].filter(Boolean).join(' · ');
};

/** A person gets their initial; everything else its kind glyph. */
function Avatar({ item }: { readonly item: Item }) {
  const Icon = glyph(item);
  const person = item.who && !automated(item) && (item.kind === 'mail' || item.kind === 'send' || item.kind === 'result');
  return (
    <span className="feed-avatar" data-person={person ? '' : undefined} aria-hidden="true">
      {person ? [...item.who!.trim()][0]?.toUpperCase() : <Icon size={16} strokeWidth={1.9} />}
    </span>
  );
}

/**
 * 피드: the assistant coming to you with what needs you, then what it did.
 * - The latest brief on top when there is one.
 * - 지금 할 일: what waits on the user, as plain sentences (first few, then 모두 보기).
 * - Then results, newest first, by day.
 * Nothing in between: no running work, no watches, no retries, no automated notices — those are the assistant's
 * business, and anything worth saying arrives as a message. A mail row opens its thread with the reply bar and one
 * action; an unconfirmed reply opens its two answers; anything else returns to that point in the conversation.
 */
export function AttentionPanel({ onOpen }: { readonly onOpen: (conversation: string, message: string | null) => void }) {
  const { data, error } = useAttention();
  const [expanded, setExpanded] = useState<string | null>(null);
  const [allPinned, setAllPinned] = useState(false);
  const [allTimeline, setAllTimeline] = useState(false);
  const [briefOpen, setBriefOpen] = useState(false);
  const confirm = async (item: Item, how: 'sent' | 'not_sent') => {
    try { await http.post(`/v1/attention/send/${item.send_task_id}/${how}`); dropAttention(item.id); void refreshAttention(); }
    catch (e) { setAttentionError(errorMessage(e)); }
  };
  const retry = async (item: Item) => {
    try { await http.post(`/v1/attention/source/${item.id.slice(6)}/retry`); setExpanded(null); void refreshAttention(); }
    catch (e) { setAttentionError(errorMessage(e)); }
  };
  const answer = async (item: Item) => {
    try { await http.post(`/v1/attention/mail/${item.id.slice(5)}/handled`); dropAttention(item.id); setExpanded(null); void refreshAttention(); }
    catch (e) { setAttentionError(errorMessage(e)); }
  };
  if (error && !data) return <ErrorNotice>{error}</ErrorNotice>;
  if (!data) return <p className="feed-note" role="status">불러오는 중…</p>;

  const now = new Date();
  const seen = new Set<string>();
  const unique = (items: readonly Item[]) => items.filter(i => !seen.has(i.id) && (seen.add(i.id), true));
  // The server orders what needs the user by urgency; keep that order.
  const needs = unique([...data.needs_you]);
  // Results only: what finished (not automated notices), and a request of the user's that could not be finished.
  const timeline = unique([...data.done, ...data.in_progress.filter(i => i.kind === 'task' && i.state === 'stopped')])
    .filter(i => !automated(i)).sort(newestFirst);
  const shownTimeline = allTimeline ? timeline : timeline.slice(0, TIMELINE_PREVIEW);
  const days: { day: number; items: Item[] }[] = [];
  for (const item of shownTimeline) {
    const day = startOfDay(new Date(item.at));
    const last = days[days.length - 1];
    if (last && last.day === day) last.items.push(item); else days.push({ day, items: [item] });
  }
  const brief = data.brief ?? null;

  if (!brief && !needs.length && !timeline.length) return <p className="feed-empty">아직 소식이 없어요.</p>;

  const expandable = (item: Item) => item.kind === 'mail' || (item.kind === 'send' && item.state === 'needs_user' && !!item.send_task_id) || (item.kind === 'watch' && item.state === 'needs_user');
  const tap = (item: Item) => expandable(item) ? setExpanded(e => e === item.id ? null : item.id) : onOpen(item.conversation_id, item.message_id);

  const row = (item: Item, tone: 'needs' | 'flow') => {
    const headId = `feed-h-${item.id}`;
    const bodyId = `feed-t-${item.id}`;
    const open = expandable(item) && expanded === item.id;
    const line = meta(item, now);
    return (
      <li key={item.id} className="feed-row" data-tone={tone} data-kind={item.kind} data-open={open || undefined}>
        <article aria-labelledby={headId}>
          <button type="button" className="feed-main" onClick={() => tap(item)}
            {...(expandable(item) ? { 'aria-expanded': open, 'aria-controls': bodyId } : {})}>
            <Avatar item={item} />
            <span className="feed-body">
              <span className="feed-sentence" id={headId}>
                {tone === 'needs' && <span className="feed-dot" aria-label="확인 필요" role="img" />}
                {sentence(item)}
              </span>
              <span className="feed-subject">{item.title}</span>
              {line && <span className="feed-meta">{line}</span>}
            </span>
            {expandable(item)
              ? <ChevronDown size={16} aria-hidden="true" className="feed-disclose" />
              : <ChevronRight size={16} aria-hidden="true" className="feed-disclose" />}
          </button>
          {open && item.kind === 'mail' && (
            <div className="feed-expanded" id={bodyId}>
              <FeedThread mailId={item.id.slice(5)} url={item.url} id={`${bodyId}-thread`} promise={item.state === 'promise'} chase={item.state === 'chase'} onChanged={() => { void refreshAttention(); }} />
              {/* One way to take it off the list; anything else (a new due date, a blocker) is said to the assistant. */}
              {item.state !== 'handled' && (
                <div className="feed-actions">
                  <button type="button" onClick={() => void answer(item)}>{item.state === 'promise' ? '했어요' : '처리했어요'}</button>
                </div>
              )}
            </div>
          )}
          {open && item.kind === 'watch' && (
            // A blocked watch (login): after logging in on the VM, look once now instead of waiting for the next check.
            <div className="feed-expanded" id={bodyId}>
              <div className="feed-choice">
                <button type="button" data-primary="" onClick={() => void retry(item)}>로그인했어요</button>
              </div>
            </div>
          )}
          {open && item.kind === 'send' && (
            // An unconfirmed reply: say what Gmail shows. Never a resend from here.
            <div className="feed-expanded" id={bodyId}>
              <div className="feed-choice">
                <button type="button" data-primary="" onClick={() => void confirm(item, 'sent')}>보낸 게 맞아요</button>
                <button type="button" onClick={() => { if (window.confirm('Gmail 보낸편지함에 이 답장이 없나요? 확인하면 다시 보낼 수 있어요.')) void confirm(item, 'not_sent'); }}>안 나갔어요</button>
              </div>
            </div>
          )}
        </article>
      </li>
    );
  };
  const shownPinned = allPinned ? needs : needs.slice(0, PINNED_PREVIEW);
  const briefLines = brief ? brief.body.split(/\r?\n/).map(l => l.trim()).filter(Boolean) : [];

  return (
    <div className="feed">
      {error && <p className="feed-note" role="alert">{error}</p>}
      {brief && briefLines.length > 0 && (
        <section className="feed-brief" aria-labelledby="feed-brief-title">
          <p className="feed-brief-kicker"><Sunrise size={14} aria-hidden="true" />{briefLabel(brief.at, now)}</p>
          <h2 id="feed-brief-title">{briefLines[0]}</h2>
          {briefLines.length > 1 && (
            <ul className="feed-brief-lines" data-clamped={!briefOpen || undefined}>
              {briefLines.slice(1).map((l, i) => <li key={i}>{l.replace(/^[-•·*]\s*/, '')}</li>)}
            </ul>
          )}
          {briefLines.length > 4 && (
            <div className="feed-brief-bar">
              <button type="button" aria-expanded={briefOpen} onClick={() => setBriefOpen(o => !o)}>{briefOpen ? '접기' : '더 보기'}</button>
            </div>
          )}
        </section>
      )}
      {needs.length > 0 ? (
        <section className="feed-section" data-section="needs" aria-labelledby="feed-now">
          <h2 id="feed-now" className="feed-label">지금 할 일 <span className="feed-count">{needs.length}</span></h2>
          <ul className="feed-list">{shownPinned.map(i => row(i, 'needs'))}</ul>
          {needs.length > PINNED_PREVIEW && (
            <button type="button" className="feed-more" aria-expanded={allPinned} onClick={() => setAllPinned(a => !a)}>
              {allPinned ? '접기' : `${needs.length}개 모두 보기`}
            </button>
          )}
        </section>
      ) : <p className="feed-calm"><CircleCheck size={16} aria-hidden="true" />지금 확인할 건 없어요.</p>}
      {days.map(({ day, items }) => (
        <section key={day} className="feed-section" aria-labelledby={`feed-day-${day}`}>
          <h2 id={`feed-day-${day}`} className="feed-label">{dayLabel(day, now)}</h2>
          <ul className="feed-list">{items.map(i => row(i, 'flow'))}</ul>
        </section>
      ))}
      {timeline.length > TIMELINE_PREVIEW && (
        <button type="button" className="feed-more" aria-expanded={allTimeline} onClick={() => setAllTimeline(a => !a)}>
          {allTimeline ? '접기' : '지난 소식 더 보기'}
        </button>
      )}
    </div>
  );
}
