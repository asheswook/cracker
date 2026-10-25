import { useEffect, useState } from 'react';
import { z } from 'zod';
import { CheckCircle2, CircleAlert, Hourglass, Inbox } from 'lucide-react';
import { http, read, errorMessage } from './api';
import { Empty, ErrorNotice } from './primitives';
import './attention.css';

const Item = z.object({
  id: z.string(), kind: z.enum(['card', 'task', 'responsibility', 'schedule', 'result', 'mail', 'watch', 'send']),
  title: z.string(), detail: z.string().nullable(), at: z.string(),
  conversation_id: z.uuid(), message_id: z.uuid().nullable(), state: z.string().nullable(),
  topic: z.string().nullable().default(null),
  url: z.string().nullable().default(null),
  send_task_id: z.string().nullable().default(null),
});
type Item = z.infer<typeof Item>;
const Attention = z.object({ needs_you: z.array(Item), in_progress: z.array(Item), done: z.array(Item) }).passthrough();
type Attention = z.infer<typeof Attention>;

const short = new Intl.DateTimeFormat('ko-KR', { month: 'numeric', day: 'numeric', hour: 'numeric', minute: '2-digit' });
const kindLabel = (item: Item): string => {
  if (item.kind === 'card') return item.state === 'draft' ? '보낼지 확인' : item.state === 'choice' ? '선택' : item.state === 'accepted' ? '승인함 · 처리 중' : item.state === 'accepted_stalled' ? '승인함 · 멈춰서 확인 중' : item.state === 'resolved' ? '처리 끝' : item.state === 'failed' ? '처리 못 함' : '확인';
  if (item.kind === 'task') return item.state === 'stopped' ? '멈춤' : item.state === 'queued' ? '대기' : '진행 중';
  if (item.kind === 'responsibility') return '지켜보는 중';
  if (item.kind === 'send') return item.state === 'needs_user' ? '답장 확인 필요' : '답장 확인 중';
  if (item.kind === 'mail') return { request: '메일 · 요청', deadline: '메일 · 기한', overdue: '메일 · 기한 지남', waiting: '메일 · 회신 대기', alert: '메일 · 알림' }[item.state ?? ''] ?? '메일';
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

/**
 * 챙길 것: what needs the user first, then what is running or being watched, then what just finished.
 * Tapping an item returns to that point in the conversation, where the card or result lives.
 */
export function AttentionPanel({ onOpen }: { readonly onOpen: (conversation: string, message: string | null) => void }) {
  const [data, setData] = useState<Attention | null>(null);
  const [error, setError] = useState('');
  useEffect(() => {
    let live = true;
    const load = () => read('/v1/attention', Attention).then(r => { if (live) { setData(r); setError(''); } }, e => { if (live) setError(errorMessage(e)); });
    void load();
    const timer = setInterval(load, 20_000);
    return () => { live = false; clearInterval(timer); };
  }, []);
  const confirm = async (item: Item, how: 'recheck' | 'sent' | 'not_sent') => {
    try { await http.post(`/v1/attention/send/${item.send_task_id}/${how}`); setData(d => d && { ...d, needs_you: d.needs_you.filter(i => i.id !== item.id) }); }
    catch (e) { setError(errorMessage(e)); }
  };
  const answer = async (item: Item, how: 'handled' | 'dismiss') => {
    try {
      await http.post(`/v1/attention/mail/${item.id.slice(5)}/${how}`);
      setData(d => d && { ...d, needs_you: d.needs_you.filter(i => i.id !== item.id), in_progress: d.in_progress.filter(i => i.id !== item.id) });
    } catch (e) { setError(errorMessage(e)); }
  };
  if (error && !data) return <ErrorNotice>{error}</ErrorNotice>;
  if (!data) return <p className="attention-note">불러오는 중…</p>;
  const empty = !data.needs_you.length && !data.in_progress.length && !data.done.length;
  if (empty) return <Empty icon={<Inbox size={24} />} title="지금 챙길 게 없어요">크래커가 확인을 기다리거나 진행 중인 일이 생기면 여기에 모여요.</Empty>;
  const section = (title: string, icon: React.ReactNode, items: Item[], tone: string, emptyText: string) => (
    <section className="attention-section" data-tone={tone} aria-label={title}>
      <h3>{icon}{title}<span>{items.length}</span></h3>
      {items.length ? (
        <ul>
          {items.map(item => (
            <li key={item.id}>
              <button type="button" onClick={() => item.kind === 'mail' && !item.message_id && item.url ? window.open(item.url, '_blank', 'noopener') : onOpen(item.conversation_id, item.message_id)}>
                <span className="attention-kind">{kindLabel(item)}{item.topic ? <span className="attention-topic"> · {item.topic}</span> : null}</span>
                <span className="attention-title">{item.title}</span>
                {detail(item) && <span className="attention-detail">{detail(item)}</span>}
                {item.kind !== 'schedule' && item.kind !== 'responsibility' && item.kind !== 'watch' && <time dateTime={item.at}>{short.format(new Date(item.at))}</time>}
              </button>
              {item.kind === 'send' && item.state === 'needs_user' && item.send_task_id && (
                // An unconfirmed reply: check again (read only) or say what Gmail shows. Never a resend from here.
                <div className="attention-actions">
                  {item.url && <a href={item.url} target="_blank" rel="noopener noreferrer">원문</a>}
                  <button type="button" onClick={() => void confirm(item, 'recheck')}>다시 확인</button>
                  <button type="button" onClick={() => void confirm(item, 'sent')}>보낸 게 맞아요</button>
                  <button type="button" onClick={() => { if (window.confirm('Gmail 보낸편지함에 이 답장이 없는 걸 확인하셨나요? 확인하면 다시 보낼 수 있어요.')) void confirm(item, 'not_sent'); }}>안 나갔어요</button>
                </div>
              )}
              {item.kind === 'mail' && (
                <div className="attention-actions">
                  {item.url && <a href={item.url} target="_blank" rel="noopener noreferrer">원문</a>}
                  <button type="button" onClick={() => void answer(item, 'handled')}>내가 처리함</button>
                  <button type="button" onClick={() => void answer(item, 'dismiss')}>필요 없음</button>
                </div>
              )}
            </li>
          ))}
        </ul>
      ) : <p className="attention-note">{emptyText}</p>}
    </section>
  );
  return (
    <div className="attention-panel">
      {section('나를 기다림', <CircleAlert size={15} aria-hidden="true" />, data.needs_you, 'needs', '확인을 기다리는 일이 없어요.')}
      {section('진행 중', <Hourglass size={15} aria-hidden="true" />, data.in_progress, 'progress', '진행 중인 일이 없어요.')}
      {section('끝남', <CheckCircle2 size={15} aria-hidden="true" />, data.done, 'done', '최근 끝난 일이 없어요.')}
    </div>
  );
}
