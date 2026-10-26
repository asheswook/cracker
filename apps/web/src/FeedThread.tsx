import { useEffect, useId, useRef, useState } from 'react';
import { z } from 'zod';
import { HTTPError } from 'ky';
import { ExternalLink, Send } from 'lucide-react';
import { http, read, errorMessage } from './api';

export const short = new Intl.DateTimeFormat('ko-KR', { month: 'numeric', day: 'numeric', hour: 'numeric', minute: '2-digit' });
export const clock = new Intl.DateTimeFormat('ko-KR', { hour: '2-digit', minute: '2-digit', hourCycle: 'h23' });
export const startOfDay = (d: Date) => new Date(d.getFullYear(), d.getMonth(), d.getDate()).getTime();
export const DAY = 86_400_000;
export const relative = (iso: string, now: Date = new Date()): string => {
  const at = new Date(iso);
  // Not a date (e.g. a mail's own time text): show it as it is rather than failing.
  if (Number.isNaN(at.getTime())) return iso;
  const diff = now.getTime() - at.getTime();
  if (diff >= 0 && diff < 60_000) return '방금';
  if (diff >= 0 && diff < 3_600_000) return `${Math.floor(diff / 60_000)}분 전`;
  const days = Math.round((startOfDay(now) - startOfDay(at)) / DAY);
  if (days === 0) return diff > 0 ? `${Math.floor(diff / 3_600_000)}시간 전` : `오늘 ${clock.format(at)}`;
  if (days === 1) return `어제 ${clock.format(at)}`;
  if (days === -1) return `내일 ${clock.format(at)}`;
  return short.format(at);
};

const Draft = z.union([
  z.object({ preparing: z.literal(true) }).passthrough(),
  z.object({
    preparing: z.literal(false), conversation_id: z.string(), message_id: z.string(), block_id: z.string(),
    target: z.string().nullable().default(null), title: z.string().nullable().default(null), body: z.string(),
    card_state: z.string(), retry_ok: z.boolean().default(false),
  }).passthrough(),
]).nullable().default(null);
export const Thread = z.object({
  id: z.string(), subject: z.string().nullable().default(null), counterpart: z.string().nullable().default(null),
  url: z.string().nullable().default(null), source: z.string().nullable().default(null), account: z.string().nullable().default(null),
  open: z.boolean(), reply_note: z.string().nullable().default(null),
  messages: z.array(z.object({ from: z.string(), from_address: z.string().nullable().default(null), at: z.string(), to: z.string().nullable().default(null), body: z.string() })),
  read_at: z.string().nullable().default(null),
  truncated: z.boolean().default(false),
  draft: Draft,
  reply_request: z.object({
    id: z.string(), state: z.enum(['queued', 'preparing', 'ready', 'failed', 'completed', 'expired']).catch('completed'),
    note: z.string().nullable(), at: z.string(),
  }).nullable().optional(),
}).passthrough();
type Thread = z.infer<typeof Thread>;
type Card = Extract<NonNullable<Thread['draft']>, { preparing: false }>;

export function replyStatus(thread: Thread | null, optimisticNote: string | null = null) {
  const request = thread?.reply_request;
  const draft = thread?.draft;
  const preparing = optimisticNote !== null || request?.state === 'queued' || request?.state === 'preparing' || (!request && !!draft?.preparing);
  return {
    preparing,
    waiting: preparing || (!!draft && !draft.preparing && draft.card_state === 'accepted'),
    note: optimisticNote ?? request?.note ?? thread?.reply_note,
    failed: request?.state === 'failed',
    expired: request?.state === 'expired',
  };
}

const placeholder = /\[[^\]\n]{0,80}\]/;

/** The server's own words for a refused request (e.g. 409 "already answered"), else the generic message. */
async function serverMessage(error: unknown): Promise<string> {
  if (error instanceof HTTPError) {
    try {
      const body = await error.response.clone().json() as { error?: { message?: unknown } | string; message?: unknown };
      const message = typeof body.error === 'object' ? body.error?.message : body.message ?? body.error;
      if (typeof message === 'string' && message.trim()) return message;
    } catch { /* not JSON */ }
  }
  return errorMessage(error);
}

function Body({ text }: { readonly text: string }) {
  const [more, setMore] = useState(false);
  const long = text.length > 320 || text.split('\n').length > 7;
  return (
    <>
      <p className="thread-text" data-clamped={long && !more ? '' : undefined}>{text}</p>
      {long && <button type="button" className="thread-more" aria-expanded={more} onClick={() => setMore(m => !m)}>{more ? '접기' : '더 보기'}</button>}
    </>
  );
}

/**
 * A mail item opened in place: the conversation so far, then a reply bar at the bottom.
 * Sending goes through the same approval endpoint as the draft card in the conversation, so it is
 * sent at most once; there is no resend from here.
 */
export function FeedThread({ mailId, url, id, onChanged, promise = false, chase = false }: {
  readonly mailId: string; readonly url: string | null; readonly id: string; readonly onChanged: () => void;
  /** A promise the user made: the next step is sending what was promised, not answering. */
  readonly promise?: boolean;
  /** A reply the user is waiting for that is late: the next step is a follow-up. */
  readonly chase?: boolean;
}) {
  const [thread, setThread] = useState<Thread | null>(null);
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);
  const [text, setText] = useState('');
  const [note, setNote] = useState('');
  const [optimisticNote, setOptimisticNote] = useState<string | null>(null);
  const draftKey = useRef('');
  const fieldId = useId();
  const noteId = useId();
  const path = `/v1/attention/mail/${mailId}`;

  const load = async () => {
    try { const t = await read(`${path}/thread`, Thread); setThread(t); setOptimisticNote(null); setError(''); return t; }
    catch (e) { setError(errorMessage(e)); return null; }
  };
  useEffect(() => { void load(); }, [mailId]); // eslint-disable-line react-hooks/exhaustive-deps

  const draft = thread?.draft ?? null;
  const card = draft && !draft.preparing ? draft as Card : null;
  const request = thread?.reply_request;
  const status = replyStatus(thread, optimisticNote);
  const { preparing, waiting } = status;
  useEffect(() => {
    if (!waiting) return;
    const timer = setInterval(() => { void load().then(t => { if (t?.draft && !t.draft.preparing && (t.draft as Card).card_state === 'resolved') onChanged(); }); }, 5_000);
    return () => clearInterval(timer);
  }, [waiting, mailId]); // eslint-disable-line react-hooks/exhaustive-deps
  // A new draft fills the box; later polls of the same draft leave the user's edits alone.
  useEffect(() => {
    if (!card) return;
    const key = `${card.message_id}:${card.block_id}`;
    if (draftKey.current !== key) { draftKey.current = key; setText(card.body); }
  }, [card?.message_id, card?.block_id, card?.body]); // eslint-disable-line react-hooks/exhaustive-deps
  useEffect(() => {
    if (request?.state === 'failed') setNote(request.note ?? '');
  }, [request?.id, request?.state]); // eslint-disable-line react-hooks/exhaustive-deps

  const requestDraft = async (value: string) => {
    setBusy(true);
    try {
      await http.post(`${path}/reply`, { json: { note: value.trim() || null } });
      setNote('');
      setOptimisticNote(value.trim());
      void load();
    } catch (e) { setError(await serverMessage(e)); }
    finally { setBusy(false); }
  };
  const send = async (c: Card) => {
    setBusy(true);
    try {
      const r = z.object({ card: z.object({ state: z.string() }).passthrough() }).passthrough().parse(await http.post(`/v1/conversations/${c.conversation_id}/messages/${c.message_id}/answer`, {
        json: { client_message_id: crypto.randomUUID(), block_id: c.block_id, option: 'send', body: text },
      }).json<unknown>());
      if (r.card.state === 'replaced') setError('메일이 바뀌었거나 이미 처리돼서 이 초안은 보낼 수 없어요.');
      setThread(t => t && t.draft && !t.draft.preparing ? { ...t, draft: { ...t.draft, card_state: r.card.state } } : t);
      onChanged();
      void load();
    } catch (e) { setError(await serverMessage(e)); }
    finally { setBusy(false); }
  };

  if (!thread) {
    return <div className="thread" id={id}>{error ? <p className="thread-error" role="alert">{error}</p> : <p className="thread-note" role="status">불러오는 중…</p>}</div>;
  }
  const account = thread.account?.toLowerCase() ?? null;
  const link = thread.url ?? url;
  const canEdit = !!card && (card.card_state === 'pending' || card.card_state === 'snoozed' || (card.card_state === 'failed' && card.retry_ok));
  const unfilled = canEdit && placeholder.test(text);
  const askBox = (label: string, cta: string, autoFocus: boolean) => (
    <form className="thread-ask" onSubmit={e => { e.preventDefault(); void requestDraft(note); }}>
      <label htmlFor={noteId} className="visually-hidden">{label}</label>
      <input id={noteId} type="text" value={note} onChange={e => setNote(e.target.value)} placeholder={label} autoFocus={autoFocus} enterKeyHint="send" disabled={busy} />
      <button type="submit" data-primary="" disabled={busy}>{cta}</button>
    </form>
  );

  let composer: React.ReactNode = null;
  if (preparing) {
    composer = <p className="thread-status" role="status"><span className="thread-dot" aria-hidden="true" />초안을 쓰고 있어요…</p>;
  } else if (status.failed) {
    composer = <><p className="thread-error" role="alert">초안을 만들지 못했어요.</p>{askBox('어떻게 답할까요?', '초안 쓰기', false)}</>;
  } else if (status.expired && thread.open) {
    composer = askBox('어떻게 답할까요?', '초안 쓰기', false);
  } else if (card?.card_state === 'accepted') {
    composer = <p className="thread-status" role="status"><span className="thread-dot" aria-hidden="true" />보내는 중…</p>;
  } else if (card?.card_state === 'resolved' && promise && thread.open) {
    // Sent, but the promise is still open until the user says it is done: another mail can be drafted.
    composer = <><p className="thread-status" data-tone="done" role="status">보냈어요</p>{askBox('더 보낼 내용이 있나요?', '초안 쓰기', false)}</>;
  } else if (card?.card_state === 'resolved') {
    composer = <p className="thread-status" data-tone="done" role="status">보냈어요</p>;
  } else if (canEdit && card) {
    composer = (
      <div className="thread-compose">
        {card.card_state === 'failed' && <p className="thread-error">보내지 못했어요.</p>}
        <label htmlFor={fieldId} className="thread-to">받는 사람 <span>{card.target ?? thread.counterpart ?? '—'}</span></label>
        <textarea id={fieldId} value={text} onChange={e => setText(e.target.value)} rows={Math.min(10, Math.max(3, text.split('\n').length + 1))} disabled={busy} aria-describedby={unfilled ? `${fieldId}-hint` : undefined} />
        {unfilled && <p id={`${fieldId}-hint`} className="thread-hint">[ ] 부분을 채워 주세요</p>}
        {/* The text is the draft: edit it here, or tell the assistant in the conversation. */}
        <div className="thread-bar">
          <button type="button" data-primary="" disabled={busy || unfilled || !text.trim()} onClick={() => void send(card)}><Send size={13} aria-hidden="true" />보내기</button>
        </div>
      </div>
    );
  } else if (thread.open && (!card || card.card_state === 'replaced')) {
    // An empty note is fine: the assistant writes it on its own.
    composer = askBox(chase ? '덧붙일 말이 있나요?' : promise ? '무엇을 보낼까요?' : '어떻게 답할까요?', '초안 쓰기', false);
  } else if (card?.card_state === 'failed') {
    composer = <p className="thread-status">보내지 못했어요.</p>;
  }

  return (
    <div className="thread" id={id}>
      {thread.messages.length ? (
        <ol className="thread-list" aria-label={thread.subject ? `${thread.subject} 주고받은 메일` : '주고받은 메일'}>
          {thread.messages.map((m, i) => {
            const mine = !!account && m.from_address?.toLowerCase() === account;
            return (
              <li key={`${m.at}-${i}`} className="thread-msg" data-mine={mine ? '' : undefined}>
                <div className="thread-meta"><strong>{mine ? '나' : m.from}</strong><time dateTime={m.at} title={Number.isNaN(new Date(m.at).getTime()) ? m.at : short.format(new Date(m.at))}>{relative(m.at)}</time></div>
                <Body text={m.body} />
              </li>
            );
          })}
        </ol>
      ) : (
        link ? <p className="thread-note"><a href={link} target="_blank" rel="noopener noreferrer">원문 보기<ExternalLink size={11} aria-hidden="true" /></a></p> : null
      )}
      {thread.messages.length > 0 && thread.truncated && link && <p className="thread-note"><a href={link} target="_blank" rel="noopener noreferrer">원문 보기<ExternalLink size={11} aria-hidden="true" /></a></p>}
      {error && <p className="thread-error" role="alert">{error}</p>}
      {composer && <div className="thread-reply">{composer}</div>}
    </div>
  );
}
