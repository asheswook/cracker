import { useEffect, useId, useMemo, useRef, useState } from 'react';
import { X } from 'lucide-react';
import { read, errorMessage } from '../api';
import { IconButton } from '../primitives';
import { MessageBubble } from '../MessageBubble';
import { BranchWorkItem, TopicBranch } from './types';
import './topics.css';

const stamp = new Intl.DateTimeFormat('ko-KR', { month: 'numeric', day: 'numeric', hour: 'numeric', minute: '2-digit' });

/** Same wording as 챙길 것, so a line reads the same wherever it shows up. */
const workLabel = (item: BranchWorkItem): string => {
  if (item.kind === 'card') return ({ draft: '보낼지 확인', choice: '선택', accepted: '승인함 · 처리 중', accepted_stalled: '승인함 · 멈춰서 확인 중', resolved: '처리 끝', failed: '처리 못 함', dismissed: '필요 없음' } as Record<string, string>)[item.state] ?? '확인';
  if (item.kind === 'task') return item.state === 'stopped' ? '멈춤' : item.state === 'queued' ? '대기' : '진행 중';
  if (item.kind === 'decision') return ({ resolved: '처리 끝', failed: '처리 못 함', dismissed: '필요 없음', accepted: '승인함', choice: '선택함' } as Record<string, string>)[item.state] ?? '처리 끝';
  return ({ sent: '보냄', posted: '게시함', scheduled: '일정 등록', booked: '예약함', updated: '바꿈', deleted: '삭제함', created: '만듦' } as Record<string, string>)[item.state] ?? '완료';
};
const workDetail = (item: BranchWorkItem): string | null => {
  if (!item.detail) return null;
  if (item.state === 'stopped' || /^Runtime\/provider\/tool failure/.test(item.detail)) return '도중에 멈췄어요. 대화에서 "이어서 해줘"라고 하면 이어 가요.';
  return item.detail;
};
const WORK_LIMIT = 5;
type WorkTone = 'needs' | 'progress' | 'results' | 'decisions';
const WORK_GROUPS: readonly { readonly key: keyof NonNullable<TopicBranch['work']>; readonly title: string; readonly tone: WorkTone }[] = [
  { key: 'needs_you', title: '나를 기다림', tone: 'needs' },
  { key: 'in_progress', title: '진행 중', tone: 'progress' },
  { key: 'results', title: '결과', tone: 'results' },
  { key: 'decisions', title: '결정한 것', tone: 'decisions' },
];

function WorkGroup({ title, tone, items, onJump }: { readonly title: string; readonly tone: WorkTone; readonly items: readonly BranchWorkItem[]; readonly onJump: (messageId: string) => void }) {
  const [open, setOpen] = useState(false);
  const headingId = useId();
  const listId = useId();
  const visible = open ? items : items.slice(0, WORK_LIMIT);
  const hidden = items.length - WORK_LIMIT;
  return (
    <section className="topic-work-group" data-tone={tone} aria-labelledby={headingId}>
      <h3 id={headingId}>{title}<span>{items.length}<span className="visually-hidden">개</span></span></h3>
      <ul id={listId}>
        {visible.map(item => {
          const text = workDetail(item);
          const inner = (
            <>
              <span className="topic-work-kind">{workLabel(item)}</span>
              <span className="topic-work-title">{item.title}</span>
              {text && <span className="topic-work-detail">{text}</span>}
              <time dateTime={item.at}>{stamp.format(new Date(item.at))}</time>
            </>
          );
          const messageId = item.message_id;
          return (
            <li key={item.id}>
              {messageId
                ? <button type="button" className="topic-work-row" onClick={() => onJump(messageId)} title="대화에서 보기">{inner}</button>
                : <div className="topic-work-row">{inner}</div>}
            </li>
          );
        })}
      </ul>
      {hidden > 0 && (
        <button type="button" className="topic-work-more" aria-expanded={open} aria-controls={listId} onClick={() => setOpen(v => !v)}>
          {open ? '접기' : `${hidden}개 더`}
        </button>
      )}
    </section>
  );
}

/** The whole branch of a topic: the focused node, its ancestors and siblings, with their conversation in time order. */
export function TopicSheet({ node, onClose, onJump }: { readonly node: string; readonly onClose: () => void; readonly onJump: (messageId: string) => void }) {
  const ref = useRef<HTMLDialogElement>(null);
  const body = useRef<HTMLDivElement>(null);
  const id = useId();
  const [branch, setBranch] = useState<TopicBranch | null>(null);
  const [error, setError] = useState('');
  const [filter, setFilter] = useState<string | null>(node);
  useEffect(() => {
    const dialog = ref.current;
    const trigger = document.activeElement instanceof HTMLElement ? document.activeElement : null;
    dialog?.showModal();
    body.current?.focus({ preventScroll: true });
    return () => { dialog?.close(); trigger?.focus({ preventScroll: true }); };
  }, []);
  useEffect(() => {
    let live = true;
    read(`/v1/topics/${node}`, TopicBranch).then(result => { if (live) { setBranch(result); setFilter(result.focus.id); } }, failure => { if (live) setError(errorMessage(failure)); });
    return () => { live = false; };
  }, [node]);
  const shown = useMemo(() => (branch?.messages ?? []).filter(m => !filter || m.node_id === filter), [branch, filter]);
  const labels = useMemo(() => new Map((branch?.nodes ?? []).map(n => [n.id, n.label])), [branch]);
  // Something waiting for the user opens at the top (the work overview); otherwise at the latest message.
  useEffect(() => { const el = body.current; if (el) el.scrollTop = branch?.work?.needs_you.length ? 0 : el.scrollHeight; }, [shown, branch]);
  const work = useMemo(() => {
    const source = branch?.work;
    return source ? WORK_GROUPS.map(g => ({ ...g, items: source[g.key] })).filter(g => g.items.length > 0) : null;
  }, [branch]);
  const jump = (messageId: string) => { onClose(); onJump(messageId); };
  const focus = branch?.focus;
  return (
    <dialog ref={ref} className="settings-dialog topic-sheet" aria-labelledby={id}
      onCancel={event => { event.preventDefault(); event.stopPropagation(); onClose(); }}
      onClick={event => { if (event.target === event.currentTarget) onClose(); }}>
      <header>
        <div className="topic-sheet-heading">
          {branch && branch.root.id !== branch.focus.id && <small>{branch.root.label}</small>}
          <h2 id={id} title={focus?.title}>{focus?.label ?? '주제'}</h2>
        </div>
        <IconButton label="닫기" onClick={onClose}><X size={18} /></IconButton>
      </header>
      {branch && branch.nodes.length > 1 && (
        <nav className="topic-sheet-branches" aria-label="가지">
          <button type="button" aria-pressed={filter === null} onClick={() => setFilter(null)}>가지 전체</button>
          {branch.nodes.map(n => (
            <button key={n.id} type="button" aria-pressed={filter === n.id} onClick={() => setFilter(n.id)} title={n.title}>
              {n.label}{n.messages ? <span>{n.messages}</span> : null}
            </button>
          ))}
        </nav>
      )}
      <div ref={body} className="topic-sheet-body" tabIndex={-1}>
        {error && <p className="topic-sheet-note">{error}</p>}
        {!branch && !error && <p className="topic-sheet-note">불러오는 중…</p>}
        {work && work.length > 0 && (
          <div className="topic-work" role="region" aria-label="이 주제의 일">
            {work.map(group => <WorkGroup key={group.key} title={group.title} tone={group.tone} items={group.items} onJump={jump} />)}
          </div>
        )}
        {branch && filter === branch.focus.id && branch.summary.length > 0 && (
          <section className="topic-sheet-summary" aria-label="지금까지 정리">
            <ul>{branch.summary.map((fact, i) => <li key={i}>{fact}</li>)}</ul>
          </section>
        )}
        {shown.map((m, i) => {
          const prev = shown[i - 1];
          const heading = filter === null && m.node_id !== prev?.node_id ? labels.get(m.node_id) : undefined;
          return (
            <div key={m.id}>
              {heading && <div className="topic-sheet-node">{heading}</div>}
              <button type="button" className={`topic-sheet-row ${m.role}`} onClick={() => { onClose(); onJump(m.id); }} aria-label={`대화에서 보기: ${stamp.format(new Date(m.created_at))}`}>
                <div className={`message ${m.role === 'user' ? 'user' : 'assistant'}`}><MessageBubble role={m.role === 'user' ? 'user' : 'assistant'} content={m.content} /></div>
                <time dateTime={m.created_at}>{stamp.format(new Date(m.created_at))}</time>
              </button>
            </div>
          );
        })}
        {branch && !shown.length && <p className="topic-sheet-note">이 주제의 대화가 아직 없어요.</p>}
      </div>
    </dialog>
  );
}
