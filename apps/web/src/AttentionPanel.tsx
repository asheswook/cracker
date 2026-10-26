import { useState } from 'react';
import { HTTPError } from 'ky';
import {
  Bell, CalendarCheck, CalendarClock, ChevronDown, ChevronRight, CircleAlert, CircleCheck, CircleHelp, Eye, ListChecks, Mail, MailCheck,
  MessageSquare, Pencil, Send, Sunrise, Trash2, type LucideIcon,
} from 'lucide-react';
import { http, errorMessage } from './api';
import { ErrorNotice } from './primitives';
import { DAY, FeedThread, relative, short, startOfDay } from './FeedThread';
import { automated, dropAttention, refreshAttention, setAttentionError, useAttention, type Item } from './attention-feed';
import './attention.css';

const dayName = new Intl.DateTimeFormat('ko-KR', { month: 'long', day: 'numeric' });
const dayNameYear = new Intl.DateTimeFormat('ko-KR', { year: 'numeric', month: 'long', day: 'numeric' });
export const briefLabel = (at: string, now = new Date()) => `${startOfDay(new Date(at)) === startOfDay(now) ? '오늘 아침 브리핑' : '최근 브리핑'} · ${relative(at, now)}`;

const kindLabel = (item: Item): string => {
  if (item.kind === 'card') return item.state === 'draft' ? '보낼지 확인' : item.state === 'choice' ? '선택' : item.state === 'accepted' ? '승인함 · 처리 중' : item.state === 'accepted_stalled' ? '승인함 · 멈춰서 확인 중' : item.state === 'resolved' ? '처리 끝' : item.state === 'failed' ? '처리 못 함' : '확인';
  if (item.kind === 'task') return item.state === 'stopped' ? '멈춤' : item.state === 'queued' ? '대기' : '진행 중';
  if (item.kind === 'responsibility') return '지켜보는 중';
  if (item.kind === 'send') return item.state === 'needs_user' ? '답장 확인 필요' : '답장 확인 중';
  if (item.kind === 'mail') return { request: '메일 · 요청', deadline: '메일 · 기한', overdue: '메일 · 기한 지남', waiting: '메일 · 회신 대기', chase: '메일 · 회신 늦음', alert: '메일 · 알림', promise: '메일 · 약속' }[item.state ?? ''] ?? '메일';
  if (item.kind === 'watch') return item.state === 'needs_user' ? '점검 막힘' : item.state === 'retrying' ? '지켜보는 중 · 다시 시도 중' : '지켜보는 중';
  if (item.kind === 'schedule') return '예약';
  return { sent: '보냄', posted: '게시함', scheduled: '일정 등록', booked: '예약함', updated: '바꿈', deleted: '삭제함', created: '만듦' }[item.state ?? ''] ?? '완료';
};
const detail = (item: Item): string | null => {
  if (!item.detail) return item.kind === 'schedule' ? short.format(new Date(item.at)) : null;
  if (item.detail.startsWith('login:')) return item.detail.slice(6);
  if (item.detail.startsWith('degraded:')) return '연결이 불안정해서 다시 시도하고 있어요';
  if (item.detail.startsWith('partial:')) return `${short.format(new Date(item.detail.slice(8)))}에 일부만 확인했어요`;
  if (item.detail.startsWith('checked:')) return item.detail === 'checked:never' ? '아직 확인 전' : `마지막 확인 ${short.format(new Date(item.detail.slice(8)))}`;
  if (item.detail.startsWith('next:')) return `다음 확인 ${short.format(new Date(item.detail.slice(5)))}`;
  if (item.state === 'stopped' || /^Runtime\/provider\/tool failure/.test(item.detail)) return '도중에 멈췄어요. 대화에서 "이어서 해줘"라고 하면 이어 가요.';
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
  if (item.kind === 'send' && who) return item.state === 'needs_user' ? `${who}에게 보낸 답장이 나갔는지 확인해 주세요` : `${who}에게 보낸 답장을 확인하고 있어요`;
  if (item.kind === 'result' && src) return ({ sent: `${who ? `${who}에게 ` : ''}${src} 답장을 보냈어요`, posted: `${src}에 게시했어요`, booked: `${src}에서 예약했어요`, scheduled: `${src}에 일정을 등록했어요` } as Record<string, string>)[item.state ?? ''] ?? null;
  if (item.kind === 'watch' && src) return item.state === 'needs_user' ? `${src} 확인이 막혔어요` : `${src} 지켜보는 중`;
  return null;
};
/** What happened, or what is needed, as a short sentence. Falls back to the status label. */
const headline = (item: Item): string => {
  const own = personal(item);
  if (own) return own;
  const s = item.state ?? '';
  const table: Partial<Record<Item['kind'], Record<string, string>>> = {
    card: { draft: '보낼지 확인해 주세요', choice: '하나 골라 주세요', accepted: '승인한 일을 처리하고 있어요', accepted_stalled: '승인한 일이 멈춰서 살펴보고 있어요', resolved: '승인한 일을 마쳤어요', failed: '승인한 일을 처리하지 못했어요', '': '확인해 주세요' },
    task: { stopped: '맡긴 일이 도중에 멈췄어요', queued: '맡긴 일이 차례를 기다려요', '': '맡긴 일을 하고 있어요' },
    send: { needs_user: '답장이 나갔는지 확인해 주세요', '': '답장이 나갔는지 확인하고 있어요' },
    mail: { request: '메일로 요청이 왔어요', deadline: '기한이 있는 메일이에요', promise: '내가 약속한 기한이 있어요', overdue: '메일 기한이 지났어요', waiting: '메일 회신을 기다리고 있어요', alert: '메일 알림이 왔어요', '': '챙겨 볼 메일이 왔어요' },
    watch: { needs_user: '지켜보다가 막혔어요', retrying: '다시 시도하며 지켜보는 중', '': '지켜보는 중' },
    responsibility: { '': '맡아서 지켜보는 중' },
    schedule: { '': '예약해 둔 일' },
    result: { sent: '보냈어요', posted: '게시했어요', scheduled: '일정을 등록했어요', booked: '예약했어요', updated: '바꿨어요', deleted: '삭제했어요', created: '만들었어요', '': '끝냈어요' },
  };
  const row = table[item.kind];
  return row?.[s] ?? row?.[''] ?? kindLabel(item);
};

const glyph = (item: Item): LucideIcon => {
  if (item.kind === 'mail') return Mail;
  if (item.kind === 'send') return MailCheck;
  if (item.kind === 'card') return item.state === 'failed' ? CircleAlert : item.state === 'resolved' ? CircleCheck : CircleHelp;
  if (item.kind === 'task') return item.state === 'stopped' ? CircleAlert : ListChecks;
  if (item.kind === 'watch') return item.state === 'needs_user' ? CircleAlert : Eye;
  if (item.kind === 'responsibility') return Eye;
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

const ongoingKinds = new Set<Item['kind']>(['watch', 'responsibility', 'schedule']);
const newestFirst = (a: Item, b: Item) => new Date(b.at).getTime() - new Date(a.at).getTime();
/** Running now: followed live in the conversation, finished ones become results in the timeline. */
const running = (item: Item) => (item.kind === 'task' && item.state !== 'stopped') || (item.kind === 'card' && item.state === 'accepted') || (item.kind === 'send' && item.state !== 'needs_user');
const draftReady = (item: Item) => item.kind === 'mail' && !!item.detail?.includes('답장 초안 준비됨');
const PINNED_PREVIEW = 5;
const TIMELINE_PREVIEW = 20;

/** The assistant speaking: the headline, plus what it has already prepared. */
const sentence = (item: Item) => {
  const line = headline(item);
  if (draftReady(item)) return `${line}. 답장 초안 써 뒀어요`;
  if (item.kind === 'mail' && item.detail?.includes('답장 초안 준비 중')) return `${line}. 답장 초안을 쓰고 있어요`;
  return line;
};
/** The muted line: when, where, and whatever the detail adds (the sender is already in the sentence). */
const meta = (item: Item, now: Date, withTime: boolean) => {
  const note = detail(item);
  const parts = item.kind === 'mail' && note ? note.split(' · ').filter(p => !item.who || !p.includes(item.who)).filter(p => !p.startsWith('답장 초안 준비')) : note ? [note] : [];
  if (item.blocked) return ['막힘', item.blocked].join(' · ');
  return [withTime ? relative(item.at, now) : null, item.source && item.kind !== 'watch' ? item.source : null, item.topic, ...parts].filter(Boolean).join(' · ');
};
/** Obligations the user can reschedule or mark stuck: their own promises and things asked of them. */
const obligation = (item: Item) => item.kind === 'mail' && ['promise', 'deadline', 'request', 'overdue'].includes(item.state ?? '');
const pad = (n: number) => String(n).padStart(2, '0');
/** A Date as the value of <input type="datetime-local"> (local wall time). */
const localValue = (d: Date) => `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}T${pad(d.getHours())}:${pad(d.getMinutes())}`;
/** Local wall time back to ISO with the browser's offset, e.g. 2026-10-30T18:00:00+09:00. */
const withOffset = (value: string) => {
  const d = new Date(value);
  const off = -d.getTimezoneOffset(), sign = off >= 0 ? '+' : '-', abs = Math.abs(off);
  return `${localValue(d)}:00${sign}${pad(Math.floor(abs / 60))}:${pad(abs % 60)}`;
};

/**
 * 원문 / 했어요 (or 내가 처리함) / 기한 바꾸기 / 막혔어요 / 필요 없음, as quiet text links.
 * 기한 바꾸기 and 막혔어요 open one small inline form each; 다시 진행 clears a block.
 */
function MailActions({ item, onDone }: { readonly item: Item; readonly onDone: (how: 'handled' | 'dismiss') => void }) {
  const [form, setForm] = useState<'due' | 'blocked' | null>(null);
  const [due, setDue] = useState(() => localValue(new Date(item.at)));
  const [reason, setReason] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const promise = item.state === 'promise';
  const save = async (json: { due_at?: string | null; blocked?: string | null }) => {
    setBusy(true); setError('');
    try {
      await http.post(`/v1/attention/mail/${item.id.slice(5)}/obligation`, { json });
      setForm(null); setReason('');
      await refreshAttention();
    } catch (e) {
      const closed = e instanceof HTTPError && e.response.status === 404;
      setError(closed ? '이미 끝난 일이에요.' : errorMessage(e));
      if (closed) void refreshAttention();
    } finally { setBusy(false); }
  };
  const toggle = (next: 'due' | 'blocked') => { setError(''); setForm(f => f === next ? null : next); };
  return (
    <>
      <div className="feed-actions">
        {item.url && <a href={item.url} target="_blank" rel="noopener noreferrer">원문</a>}
        <button type="button" data-primary="" onClick={() => onDone('handled')} disabled={busy}>{promise ? '했어요' : '내가 처리함'}</button>
        {obligation(item) && <button type="button" aria-expanded={form === 'due'} onClick={() => toggle('due')} disabled={busy}>기한 바꾸기</button>}
        {obligation(item) && (item.blocked
          ? <button type="button" onClick={() => void save({ blocked: null })} disabled={busy}>다시 진행</button>
          : <button type="button" aria-expanded={form === 'blocked'} onClick={() => toggle('blocked')} disabled={busy}>막혔어요</button>)}
        <button type="button" onClick={() => onDone('dismiss')} disabled={busy}>필요 없음</button>
      </div>
      {item.blocked && <p className="feed-blocked">막힘 · {item.blocked}</p>}
      {form === 'due' && (
        <form className="feed-inline" onSubmit={e => { e.preventDefault(); if (due) void save({ due_at: withOffset(due) }); }}>
          <label className="visually-hidden" htmlFor={`due-${item.id}`}>새 기한</label>
          <input id={`due-${item.id}`} type="datetime-local" value={due} onChange={e => setDue(e.target.value)} required disabled={busy} />
          <button type="submit" disabled={busy || !due}>저장</button>
        </form>
      )}
      {form === 'blocked' && (
        <form className="feed-inline" onSubmit={e => { e.preventDefault(); void save({ blocked: reason.trim() || null }); }}>
          <label className="visually-hidden" htmlFor={`blocked-${item.id}`}>무엇 때문에 막혔나요?</label>
          <input id={`blocked-${item.id}`} type="text" value={reason} onChange={e => setReason(e.target.value)} placeholder="무엇 때문에 막혔나요?" autoFocus enterKeyHint="done" disabled={busy} />
          <button type="submit" disabled={busy || !reason.trim()}>저장</button>
        </form>
      )}
      {error && <p className="feed-note" role="alert">{error}</p>}
    </>
  );
}

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
 * 피드: the assistant coming to you with what needs you, and everything else quietly behind it.
 * - The latest brief on top when there is one.
 * - 지금 할 일: what waits on the user, as plain sentences from the assistant (first few, then 모두 보기).
 * - 하고 있는 일: running work, live; tapping goes to the conversation where it is happening.
 * - Then what happened, newest first, by day. Bot/alert mail folds into 알림; watches into 지켜보는 것.
 * Rows carry no buttons: a mail row opens its thread in place (reply bar and 원문 / 내가 처리함 / 필요 없음 inside);
 * an unconfirmed reply opens its three choices; anything else returns to that point in the conversation.
 */
export function AttentionPanel({ onOpen }: { readonly onOpen: (conversation: string, message: string | null) => void }) {
  const { data, error } = useAttention();
  const [expanded, setExpanded] = useState<string | null>(null);
  const [allPinned, setAllPinned] = useState(false);
  const [allTimeline, setAllTimeline] = useState(false);
  // 전체: everything that happened; 한 일: only what the assistant itself sent, posted, scheduled, changed or deleted.
  const [filter, setFilter] = useState<'all' | 'done'>('all');
  const [briefOpen, setBriefOpen] = useState(false);
  const confirm = async (item: Item, how: 'recheck' | 'sent' | 'not_sent') => {
    try { await http.post(`/v1/attention/send/${item.send_task_id}/${how}`); dropAttention(item.id); void refreshAttention(); }
    catch (e) { setAttentionError(errorMessage(e)); }
  };
  const retry = async (item: Item) => {
    try { await http.post(`/v1/attention/source/${item.id.slice(6)}/retry`); setExpanded(null); void refreshAttention(); }
    catch (e) { setAttentionError(errorMessage(e)); }
  };
  const answer = async (item: Item, how: 'handled' | 'dismiss') => {
    try { await http.post(`/v1/attention/mail/${item.id.slice(5)}/${how}`); dropAttention(item.id); setExpanded(null); void refreshAttention(); }
    catch (e) { setAttentionError(errorMessage(e)); }
  };
  if (error && !data) return <ErrorNotice>{error}</ErrorNotice>;
  if (!data) return <p className="feed-note" role="status">불러오는 중…</p>;

  const now = new Date();
  const seen = new Set<string>();
  const unique = (items: readonly Item[]) => items.filter(i => !seen.has(i.id) && (seen.add(i.id), true));
  // The server orders what needs the user by urgency; keep that order.
  const needs = unique([...data.needs_you]);
  const rest = unique([...data.in_progress, ...data.done]);
  const alerts = rest.filter(automated);
  const live = rest.filter(i => running(i) && !automated(i)).sort(newestFirst);
  const ongoing = rest.filter(i => ongoingKinds.has(i.kind)).sort(newestFirst);
  const timeline = rest.filter(i => !ongoingKinds.has(i.kind) && !running(i) && !automated(i)).sort(newestFirst);
  const actions = rest.filter(i => i.kind === 'result').sort(newestFirst);
  const stream = filter === 'done' ? actions : timeline;
  const shownTimeline = allTimeline ? stream : stream.slice(0, TIMELINE_PREVIEW);
  const days: { day: number; items: Item[] }[] = [];
  for (const item of shownTimeline) {
    const day = startOfDay(new Date(item.at));
    const last = days[days.length - 1];
    if (last && last.day === day) last.items.push(item); else days.push({ day, items: [item] });
  }
  const brief = data.brief ?? null;

  if (!brief && !needs.length && !rest.length) {
    return <p className="feed-empty">아직 소식이 없어요. 맡긴 일이 생기면 여기 쌓여요.</p>;
  }

  const expandable = (item: Item) => item.kind === 'mail' || (item.kind === 'send' && item.state === 'needs_user' && !!item.send_task_id) || (item.kind === 'watch' && item.state === 'needs_user');
  const tap = (item: Item) => expandable(item) ? setExpanded(e => e === item.id ? null : item.id) : onOpen(item.conversation_id, item.message_id);

  const row = (item: Item, tone: 'needs' | 'live' | 'flow' | 'quiet' | 'action') => {
    const headId = `feed-h-${item.id}`;
    const bodyId = `feed-t-${item.id}`;
    const open = expandable(item) && expanded === item.id;
    const withTime = !ongoingKinds.has(item.kind);
    // In 한 일 a row says only when and where; the target is already in the sentence.
    const line = tone === 'action' ? [relative(item.at, now), item.source].filter(Boolean).join(' · ')
      : [tone === 'needs' && automated(item) ? '자동' : null, meta(item, now, withTime)].filter(Boolean).join(' · ');
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
              {line && <span className="feed-meta">{tone === 'live' && <span className="feed-live" aria-hidden="true" />}{line}</span>}
            </span>
            {expandable(item)
              ? <ChevronDown size={16} aria-hidden="true" className="feed-disclose" />
              : <ChevronRight size={16} aria-hidden="true" className="feed-disclose" />}
          </button>
          {open && item.kind === 'mail' && (
            <div className="feed-expanded" id={bodyId}>
              <FeedThread mailId={item.id.slice(5)} url={item.url} id={`${bodyId}-thread`} promise={item.state === 'promise'} chase={item.state === 'chase'} onChanged={() => { void refreshAttention(); }} />
              <MailActions item={item} onDone={how => void answer(item, how)} />
            </div>
          )}
          {open && item.kind === 'watch' && (
            // A blocked watch (login): after logging in on the VM, look once now instead of waiting for the next check.
            <div className="feed-expanded" id={bodyId}>
              <p className="feed-explain">{detail(item)}</p>
              <div className="feed-choice">
                <button type="button" data-primary="" onClick={() => void retry(item)}>로그인했어요, 다시 확인</button>
              </div>
            </div>
          )}
          {open && item.kind === 'send' && (
            // An unconfirmed reply: check again (read only) or say what Gmail shows. Never a resend from here.
            <div className="feed-expanded" id={bodyId}>
              <p className="feed-explain">{detail(item)}</p>
              <div className="feed-choice">
                <button type="button" data-primary="" onClick={() => void confirm(item, 'sent')}>보낸 게 맞아요</button>
                <button type="button" onClick={() => void confirm(item, 'recheck')}>다시 확인</button>
                <button type="button" onClick={() => { if (window.confirm('Gmail 보낸편지함에 이 답장이 없는 걸 확인하셨나요? 확인하면 다시 보낼 수 있어요.')) void confirm(item, 'not_sent'); }}>안 나갔어요</button>
              </div>
              {item.url && <div className="feed-actions"><a href={item.url} target="_blank" rel="noopener noreferrer">원문</a></div>}
            </div>
          )}
        </article>
      </li>
    );
  };
  const fold = (id: string, Icon: LucideIcon, label: string, items: Item[], hint: string | null) => items.length > 0 && (
    <details className="feed-fold" key={id}>
      <summary>
        <span className="feed-avatar" aria-hidden="true"><Icon size={16} strokeWidth={1.9} /></span>
        <span className="feed-fold-text"><span>{label} {items.length}개</span>{hint && <small>{hint}</small>}</span>
        <ChevronRight size={16} aria-hidden="true" className="feed-fold-chevron" />
      </summary>
      <ul className="feed-list">{items.map(i => row(i, 'quiet'))}</ul>
    </details>
  );
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
          <div className="feed-brief-bar">
            {briefLines.length > 4 && <button type="button" aria-expanded={briefOpen} onClick={() => setBriefOpen(o => !o)}>{briefOpen ? '접기' : '더 보기'}</button>}
            {brief.conversation_id && <button type="button" onClick={() => onOpen(brief.conversation_id!, brief.message_id)}>대화에서 보기</button>}
          </div>
        </section>
      )}
      {needs.length > 0 ? (
        <section className="feed-section" data-section="needs" aria-labelledby="feed-now">
          <h2 id="feed-now" className="feed-label">지금 할 일 <span className="feed-count">{needs.length}</span></h2>
          <ul className="feed-list">{shownPinned.map(i => row(i, 'needs'))}</ul>
          {needs.length > PINNED_PREVIEW && (
            <button type="button" className="feed-more" aria-expanded={allPinned} onClick={() => setAllPinned(a => !a)}>
              {allPinned ? '접기' : `${needs.length}개 중 ${PINNED_PREVIEW}개 · 모두 보기`}
            </button>
          )}
        </section>
      ) : (brief || rest.length > 0) && <p className="feed-calm"><CircleCheck size={16} aria-hidden="true" />지금 확인할 건 없어요.</p>}
      {live.length > 0 && (
        <section className="feed-section" aria-labelledby="feed-live">
          <h2 id="feed-live" className="feed-label">하고 있는 일</h2>
          <ul className="feed-list">{live.map(i => row(i, 'live'))}</ul>
        </section>
      )}
      {(alerts.length > 0 || ongoing.length > 0) && (
        <div className="feed-folds">
          {fold('alerts', Bell, '자동 알림', alerts, null)}
          {fold('ongoing', Eye, '지켜보는 것', ongoing, null)}
        </div>
      )}
      {(timeline.length > 0 || actions.length > 0) && (
        <div className="feed-filter" role="group" aria-label="소식 보기">
          {([['all', '전체'], ['done', '한 일']] as const).map(([value, label]) => (
            <button key={value} type="button" aria-pressed={filter === value}
              onClick={() => { setFilter(value); setAllTimeline(false); setExpanded(null); }}>{label}</button>
          ))}
        </div>
      )}
      {filter === 'done' && !actions.length && <p className="feed-calm feed-calm-quiet">아직 크래커가 한 일이 없어요.</p>}
      {days.map(({ day, items }) => (
        <section key={`${filter}-${day}`} className="feed-section" aria-labelledby={`feed-day-${filter}-${day}`}>
          <h2 id={`feed-day-${filter}-${day}`} className="feed-label">{dayLabel(day, now)}</h2>
          <ul className="feed-list">{items.map(i => row(i, filter === 'done' ? 'action' : 'flow'))}</ul>
        </section>
      ))}
      {stream.length > TIMELINE_PREVIEW && (
        <button type="button" className="feed-more" aria-expanded={allTimeline} onClick={() => setAllTimeline(a => !a)}>
          {allTimeline ? '접기' : '지난 소식 더 보기'}
        </button>
      )}
    </div>
  );
}
