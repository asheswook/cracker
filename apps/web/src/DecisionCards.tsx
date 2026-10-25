import { useId, useState } from 'react';
import { Check, Clock3, Loader2, Mail, MessageSquare, PenLine, Send, X } from 'lucide-react';
import { errorMessage } from './api';
import { client } from './store';
import type { AnswerBlock, ChoiceBlock, DraftBlock, Message } from './types';
import './decision-cards.css';

type CardState = NonNullable<Message['card_states']>[string]['state'];

/** The card's state; a snooze that has ended is pending again. */
function cardState(message: Message, block: string, answer: AnswerBlock | undefined): CardState | undefined {
  const known = message.card_states?.[block];
  if (known?.state === 'snoozed' && known.snoozed_until && Date.parse(known.snoozed_until) <= Date.now()) return 'pending';
  return known?.state ?? (answer && answer.option !== 'later' ? 'accepted' : undefined);
}

function channelIcon(channel: string) {
  return /mail|메일/i.test(channel) ? Mail : /slack|discord|teams|메신저|카톡/i.test(channel) ? MessageSquare : Send;
}

/** What the card says about itself once the user answered: the press, then what happened to the work. */
function status(state: CardState | undefined, answer: AnswerBlock | undefined, sent: string) {
  if (state === 'accepted') return { icon: <Loader2 size={12} className="spin" aria-hidden="true" />, text: answer ? `${answer.label} · 처리 중` : '처리 중', tone: 'busy' };
  if (state === 'resolved') return { icon: <Check size={12} aria-hidden="true" />, text: sent, tone: 'done' };
  if (state === 'failed') return { icon: <X size={12} aria-hidden="true" />, text: '처리하지 못했어요', tone: 'failed' };
  if (state === 'dismissed') return { icon: <X size={12} aria-hidden="true" />, text: '필요 없음', tone: 'muted' };
  if (state === 'superseded') return { icon: <Check size={12} aria-hidden="true" />, text: '메일에서 이미 처리됨', tone: 'muted' };
  if (state === 'replaced') return { icon: <X size={12} aria-hidden="true" />, text: '메일이 바뀌어서 보낼 수 없어요', tone: 'muted' };
  if (state === 'snoozed') return { icon: <Clock3 size={12} aria-hidden="true" />, text: '다음 브리핑 때 다시 물어볼게요', tone: 'muted' };
  return null;
}

/** Text the assistant wrote that goes out only when the user taps 보내기; 수정 opens it for editing in place. */
export function DraftCard({ message, block, answer }: { readonly message: Message; readonly block: DraftBlock; readonly answer: AnswerBlock | undefined }) {
  const state = cardState(message, block.id, answer);
  const [editing, setEditing] = useState(false);
  const [text, setText] = useState(block.body);
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState('');
  const id = useId();
  const Icon = channelIcon(block.channel);
  // A send that failed can be tried again from the same card.
  // A failed send is re-approvable only when it is proven not to have gone out.
  const open = !state || state === 'pending' || state === 'snoozed' || (state === 'failed' && message.card_states?.[block.id]?.retry_ok === true);
  const shown = status(state, answer, '보냄');
  const act = async (option: 'send' | 'later' | 'dismiss', body?: string) => {
    setBusy(option); setError('');
    try { await client.answerCard(message, block.id, option, body); setEditing(false); }
    catch (failure) { setError(errorMessage(failure)); }
    finally { setBusy(null); }
  };
  // What the user approved (edited or not) is what the card shows and what a retry sends.
  const approved = message.card_states?.[block.id]?.approved_body ?? (answer?.body && answer.option !== 'later' ? answer.body : null);
  const body = editing ? text : approved ?? block.body;
  // Placeholders the assistant left for the user: sending opens the editor instead.
  const unfilled = /\[(?:\s*|[^\]\n]{0,80}(?:\/|여부|시간|날짜|이름|금액|확인|입력|선택|가능)[^\]\n]{0,80})\](?!\()/.test(editing ? text : block.body);
  return (
    <section className="decision-card draft-card" aria-labelledby={id} data-tone={shown?.tone}>
      <header>
        <span className="decision-card-icon" aria-hidden="true"><Icon size={15} /></span>
        <span id={id} className="decision-card-title">{block.channel}</span>
        <span className="decision-card-state" role="status">{shown && !(open && state === 'snoozed') ? <>{shown.icon}{shown.text}</> : '초안'}</span>
      </header>
      {(block.target || block.title) && (
        <dl>
          {block.target && <><dt>받는 사람</dt><dd>{block.target}</dd></>}
          {block.title && <><dt>제목</dt><dd>{block.title}</dd></>}
        </dl>
      )}
      {editing && open
        ? <textarea className="draft-card-editor" value={text} onChange={e => setText(e.target.value)} rows={Math.min(12, Math.max(4, text.split('\n').length + 1))} aria-label="초안 수정" autoFocus />
        : <p className="draft-card-body">{body}</p>}
      {open && (
        <footer>
          {editing ? (
            <>
              <button type="button" className="decision-secondary" disabled={!!busy} onClick={() => { setEditing(false); setText(block.body); }}>취소</button>
              <button type="button" className="decision-primary" disabled={!!busy || !text.trim() || unfilled} onClick={() => void act('send', text)}>{busy === 'send' ? '보내는 중…' : '이대로 보내기'}</button>
            </>
          ) : (
            <>
              <button type="button" className="decision-quiet" disabled={!!busy} onClick={() => void act('dismiss')}>{busy === 'dismiss' ? '…' : '필요 없음'}</button>
              {state !== 'snoozed' && <button type="button" className="decision-secondary" disabled={!!busy} onClick={() => void act('later')}>{busy === 'later' ? '…' : '나중에'}</button>}
              <button type="button" className="decision-secondary" disabled={!!busy} onClick={() => { setText(approved ?? block.body); setEditing(true); }}><PenLine size={13} aria-hidden="true" />수정</button>
              <button type="button" className="decision-primary" disabled={!!busy} onClick={() => unfilled ? setEditing(true) : void act('send', approved ?? undefined)}>{busy === 'send' ? '보내는 중…' : unfilled ? '채워서 보내기' : '보내기'}</button>
            </>
          )}
        </footer>
      )}
      {open && unfilled && <p className="decision-note">[ ] 부분을 채워야 보낼 수 있어요.</p>}
      {open && state === 'snoozed' && <p className="decision-note">다음 브리핑 때 다시 보여 드릴게요.</p>}
      {error && <p className="decision-error" role="alert">{error}</p>}
    </section>
  );
}

/** A short decision. After an answer, the chosen option stays visible with what happened next. */
export function ChoiceCard({ message, block, answer }: { readonly message: Message; readonly block: ChoiceBlock; readonly answer: AnswerBlock | undefined }) {
  const state = cardState(message, block.id, answer);
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState('');
  const id = useId();
  const open = !state || state === 'pending' || state === 'snoozed';
  const pick = async (option: string) => {
    setBusy(option); setError('');
    try { await client.answerCard(message, block.id, option); }
    catch (failure) { setError(errorMessage(failure)); }
    finally { setBusy(null); }
  };
  const chosen = answer && answer.option !== 'later' ? answer.label : block.options.find(o => o.id === message.card_states?.[block.id]?.option)?.label;
  const shown = status(state, answer, '처리 끝');
  return (
    <section className="decision-card choice-card" aria-labelledby={id} data-tone={shown?.tone}>
      <p id={id} className="choice-card-question">{block.question}</p>
      {open ? (
        <>
          <div className="choice-card-options" role="group" aria-labelledby={id}>
            {block.options.filter(option => !(state === 'snoozed' && option.id === 'later')).map(option => (
              <button key={option.id} type="button" className={option.id === 'later' ? 'decision-secondary' : 'decision-option'} disabled={!!busy} onClick={() => void pick(option.id)}>
                {busy === option.id ? '…' : option.label}
              </button>
            ))}
            <button type="button" className="decision-quiet" disabled={!!busy} onClick={() => void pick('dismiss')}>{busy === 'dismiss' ? '…' : '필요 없음'}</button>
          </div>
          {state === 'snoozed' && <p className="decision-note">다음 브리핑 때 다시 물어볼게요.</p>}
        </>
      ) : (
        <p className="choice-card-answer" role="status">
          {state === 'dismissed' ? <><X size={13} aria-hidden="true" />필요 없음</> : state === 'superseded' ? <><Check size={13} aria-hidden="true" />메일에서 이미 처리됨</> : state === 'replaced' ? <><X size={13} aria-hidden="true" />메일이 바뀌어서 보낼 수 없어요</> : <><Check size={13} aria-hidden="true" />{chosen ?? '답함'}{shown && state !== 'resolved' ? <span className="choice-card-progress"> · {shown.text}</span> : null}</>}
        </p>
      )}
      {error && <p className="decision-error" role="alert">{error}</p>}
    </section>
  );
}
