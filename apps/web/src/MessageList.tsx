import { memo, useContext, useLayoutEffect, useMemo, useRef, useState } from 'react';
import { MessageTimeControl } from './MessageTimeControl';
import { HeaderTimeContext } from './header-time-context';
import { AnimatePresence, m as Motion } from 'motion/react';
import { createPortal } from 'react-dom';
import { RefreshCw, Repeat2 } from 'lucide-react';
import type { Message, Pending } from './types';
import { Attachments } from './Attachments';
import { ResultCard } from './ResultCard';
import { ChoiceCard, DraftCard } from './DecisionCards';
import { MessageBubble } from './MessageBubble';
import { SystemEvent } from './SystemEvent';
import { systemMessageContent } from './system-message';
import { dayDividers } from './feed-labels';
import { client } from './store';
import { useMessageTimeReveal } from './useMessageTimeReveal';
import './message-time-reveal.css';
import { feedItems } from './background-message';
import type { BackgroundRun } from './background-message';
import { BackgroundRunDialog } from './BackgroundRunDialog';
import { useConversationTopics } from './topics/useConversationTopics';
import { TopicSheet } from './topics/TopicSheet';
import './topics/topics.css';
import './background-message.css';

const dayFormatter = new Intl.DateTimeFormat('ko-KR', {
  year: 'numeric',
  month: 'long',
  day: 'numeric',
  weekday: 'short',
});
function changedDay(current: string, previous: string | undefined): boolean {
  return !previous || new Date(current).toDateString() !== new Date(previous).toDateString();
}
const INITIAL_WINDOW = 120;
const timeOf = (at: string) => new Date(at).toLocaleTimeString('ko-KR', { hour: 'numeric', minute: '2-digit' });
function DayDivider({ date }: { readonly date: string }) {
  return (
    <div className="day-divider">
      <span>{dayFormatter.format(new Date(date))}</span>
    </div>
  );
}
export const MessageList = memo(function MessageList({
  messages,
  pending,
  reduced,
  arrivals,
  assistantName = '크래커',
  timeControlRoot = null,
  keep = null,
  objectives,
}: {
  messages: Message[];
  pending: Pending[];
  reduced: boolean | null;
  arrivals: ReadonlySet<string>;
  assistantName?: string;
  timeControlRoot?: HTMLElement | null;
  keep?: string | null;
  /** Task objectives by id, used to title scheduled runs whose wake notice is not in view. */
  objectives?: ReadonlyMap<string, string>;
}) {
  const times = useMessageTimeReveal(reduced, messages[0]?.conversation_id ?? pending[0]?.conversation_id);
  const registerTime = useContext(HeaderTimeContext);
  const toggleTime = useRef(times.toggle);
  toggleTime.current = times.toggle;
  useLayoutEffect(() => {
    registerTime?.({ available: messages.length > 0, pinned: times.pinned, toggle: () => toggleTime.current() });
    return () => registerTime?.(null);
  }, [registerTime, times.pinned, messages.length]);
  const latestUserId = [...messages].reverse().find((message) => message.role === 'user')?.id;
  const conversation = messages[0]?.conversation_id ?? null;
  const [windowed, setWindowed] = useState({ conversation, size: INITIAL_WINDOW });
  const size = windowed.conversation === conversation ? windowed.size : INITIAL_WINDOW;
  const shown = useMemo(() => messages.filter(message => systemMessageContent(message) !== null), [messages]);
  const keepIndex = keep ? shown.findIndex(message => message.id === keep || message.task_id === keep) : -1;
  const start = Math.max(0, Math.min(shown.length - size, keepIndex >= 0 ? keepIndex - 20 : shown.length));
  const visibleMessages = useMemo(() => shown.slice(start), [shown, start]);
  const items = useMemo(() => feedItems(visibleMessages, objectives), [visibleMessages, objectives]);
  const [openRun, setOpenRun] = useState<string | null>(null);
  const topics = useConversationTopics(conversation, messages.at(-1)?.id);
  // Answers to cards, keyed by the card message and block, so an answered card shows its outcome instead of buttons.
  const answers = useMemo(() => {
    const out = new Map<string, Extract<NonNullable<Message['blocks']>[number], { kind: 'answer' }>>();
    for (const message of messages) for (const block of message.blocks ?? []) if (block.kind === 'answer') out.set(`${block.message_id}:${block.block_id}`, block);
    return out;
  }, [messages]);
  const [openTopic, setOpenTopic] = useState<string | null>(null);
  // A chip is shown where the topic changes; a run of messages in one topic carries one chip.
  const chips = useMemo(() => {
    const out = new Map<string, { node: string; label: string; side: 'user' | 'assistant' }>();
    let prev: string | null | undefined;
    for (const item of items) {
      const first = item.kind === 'run' ? item.messages[0] : item.message;
      if (!first) continue;
      const node = (item.kind === 'run' ? item.messages.map(m => topics.byMessage.get(m.id)?.node).find(Boolean) : topics.byMessage.get(first.id)?.node) ?? null;
      if (node && node !== prev) {
        const label = topics.nodes.get(node)?.label;
        if (label) out.set(first.id, { node, label, side: first.role === 'user' ? 'user' : 'assistant' });
      }
      if (node || first.role === 'user') prev = node;
    }
    return out;
  }, [items, topics]);
  const chip = (id: string) => {
    const c = chips.get(id);
    return c ? [<button key={`topic-${id}`} type="button" className="topic-chip" data-side={c.side} aria-haspopup="dialog" aria-label={`주제 보기: ${c.label}`} onClick={() => setOpenTopic(c.node)}><span>{c.label}</span></button>] : [];
  };
  const jump = (messageId: string) => {
    const node = document.getElementById(`message-${messageId}`);
    if (!node) return;
    node.scrollIntoView({ block: 'center', behavior: reduced ? 'instant' : 'smooth' });
    node.classList.add('task-highlight');
    setTimeout(() => node.classList.remove('task-highlight'), 2400);
  };
  const opened = openRun ? items.find((item): item is BackgroundRun => item.kind === 'run' && item.messages[0]?.id === openRun) : undefined;
  const hidden = start;
  const dividers = useMemo(() => {
    const all = new Set(dayDividers(shown));
    const first = shown[start];
    if (first) all.add(first.id);
    return all;
  }, [shown, start]);
  return (
    <Motion.div
      ref={times.ref}
      className="message-column time-reveal"
      onKeyDown={(event) => {
        if (event.key === 'Escape') times.close();
      }}
    >
      {hidden > 0 && (
        <button type="button" className="older-messages" onClick={() => setWindowed({ conversation, size: size + 200 })}>
          이전 메시지 {hidden.toLocaleString('ko-KR')}개 더 보기
        </button>
      )}
      {messages.length > 0 && timeControlRoot && createPortal(
          <MessageTimeControl pinned={times.pinned} onToggle={times.toggle} />,
          timeControlRoot,
      )}
      <AnimatePresence>
        {[
          ...items.flatMap((item, index) => {
            const previousItem = items[index - 1];
            if (item.kind === 'run') {
              const [first, ...rest] = item.messages;
              if (!first) return [];
              const newDay = item.messages.some(message => dividers.has(message.id));
              return [
                ...(newDay ? [<DayDivider key={`day-${first.id}`} date={first.created_at} />] : []),
                ...chip(first.id),
                <Motion.article
                  key={first.client_message_id ?? first.id}
                  id={`message-${first.id}`}
                  data-task-id={first.task_id ?? undefined}
                  className="message background-run new-speaker"
                  aria-label="자동 작업"
                  initial={!reduced && arrivals.has(first.client_message_id ?? first.id) ? { opacity: 0, y: 10 } : false}
                  animate={{ opacity: 1, y: 0 }}
                  transition={{ duration: reduced ? 0 : 0.2, ease: [0.32, 0.72, 0, 1] }}
                >
                  {rest.map(message => <span key={message.id} id={`message-${message.id}`} className="background-run-anchor" />)}
                  <button
                    type="button"
                    className="background-run-row"
                    aria-label={`자동 작업 결과 보기: ${item.title}`}
                    aria-haspopup="dialog"
                    onClick={() => setOpenRun(first.id)}
                  >
                    <Repeat2 size={13} aria-hidden="true" />
                    <span className="background-run-title">{item.title}</span>
                    {item.preview && <span className="background-run-preview">{item.preview}</span>}
                    {item.at && <time dateTime={item.at}>{timeOf(item.at)}</time>}
                  </button>
                </Motion.article>,
              ];
            }
            const m = item.message;
            const systemContent = systemMessageContent(m);
            if (systemContent === null) return [];
            const previous = previousItem?.kind === 'message' ? previousItem.message : undefined;
            const newDay = dividers.has(m.id);
            const chipped = chip(m.id);
            return [
              ...(newDay ? [<DayDivider key={`day-${m.id}`} date={m.created_at} />] : []),
              ...chipped,
              <Motion.article
                key={m.client_message_id ?? m.id}
                id={`message-${m.id}`}
                data-task-id={m.task_id ?? undefined}
                className={`message ${m.role} ${!newDay && !chipped.length && previous?.role === m.role ? 'same-speaker' : 'new-speaker'}`}
                aria-label={
                  m.role === 'system' ? '시스템 알림' : m.role === 'assistant' ? assistantName : '내 메시지'
                }
                title={new Date(m.created_at).toLocaleString('ko-KR')}
                initial={!reduced && arrivals.has(m.client_message_id ?? m.id) ? { opacity: 0, y: 10 } : false}
                animate={{ opacity: 1, y: 0 }}
                transition={{ duration: reduced ? 0 : 0.2, ease: [0.32, 0.72, 0, 1] }}
              >
                {m.role === 'system' ? (
                  <SystemEvent>{systemContent}</SystemEvent>
                ) : m.blocks?.length ? (
                  // Cards carry the facts; the text fallback stays for notifications and search.
                  m.blocks.map((block, i) => block.kind === 'result' ? <ResultCard key={i} block={block} />
                    : block.kind === 'draft' ? <DraftCard key={i} message={m} block={block} answer={answers.get(`${m.id}:${block.id}`)} />
                    : block.kind === 'choice' ? <ChoiceCard key={i} message={m} block={block} answer={answers.get(`${m.id}:${block.id}`)} />
                    : <div key={i} className="bubble user"><span>{block.label}</span>{block.body && block.option !== 'later' ? <span className="answer-body">{block.body.length > 120 ? `${block.body.slice(0, 120)}…` : block.body}</span> : null}</div>)
                ) : (
                  <MessageBubble role={m.role} content={m.content} />
                )}
                <Attachments items={m.attachments} />
                <time className="message-time" dateTime={m.created_at}>
                  {timeOf(m.created_at)}
                </time>
                {m.role === 'user' && (
                  <Motion.div
                    className="receipt-shell"
                    aria-hidden={m.id !== latestUserId || pending.length > 0}
                    initial={false}
                    animate={{
                      height: m.id === latestUserId && pending.length === 0 ? 'auto' : 0,
                      opacity: m.id === latestUserId && pending.length === 0 ? 1 : 0,
                    }}
                    transition={{ duration: reduced ? 0 : 0.4, ease: [0.25, 0.1, 0.25, 1] }}
                  >
                    <Motion.span
                      animate={{ scale: m.id === latestUserId && pending.length === 0 ? 1 : 0 }}
                      transition={{ duration: reduced ? 0 : 0.4, ease: [0.25, 0.1, 0.25, 1] }}
                      key={m.read_at ?? 'delivered'}
                      className="message-receipt"
                      title={
                        m.read_at
                          ? `어시스턴트가 메시지를 읽었어요 · ${new Date(m.read_at).toLocaleTimeString('ko-KR')}`
                          : '서버에 메시지가 저장됐어요'
                      }
                    >
                      {m.read_at
                        ? `읽음 ${new Date(m.read_at).toLocaleTimeString('ko-KR', { hour: 'numeric', minute: '2-digit' })}`
                        : '전달됨'}
                    </Motion.span>
                  </Motion.div>
                )}
              </Motion.article>,
            ];
          }),
          ...pending.flatMap((m, index) => [
            ...(changedDay(m.created_at, pending[index - 1]?.created_at ?? visibleMessages.at(-1)?.created_at)
              ? [<DayDivider key={`pending-day-${m.client_message_id}`} date={m.created_at} />]
              : []),
            <Motion.article
              key={m.client_message_id}
              data-pending-id={m.client_message_id}
              initial={!reduced && arrivals.has(m.client_message_id) ? { opacity: 0, y: 10 } : false}
              animate={{ opacity: 1, y: 0 }}
              transition={{ duration: reduced ? 0 : 0.2, ease: [0.32, 0.72, 0, 1] }}
              className={`message user ${index > 0 || messages.at(-1)?.role === 'user' ? 'same-speaker' : 'new-speaker'}`}
            >
              <MessageBubble role="user" content={m.content} />
              <Attachments items={m.attachments} />
              <span className="message-meta">
                {m.state === 'failed' ? (
                  <button className="retry-message" onClick={() => void client.retry(m)}>
                    <RefreshCw size={12} />
                    전송 실패 · 다시 보내기
                  </button>
                ) : m.state === 'sending' ? (
                  '전송 중'
                ) : (
                  '전송 대기'
                )}
              </span>
            </Motion.article>,
          ]),
        ]}
      </AnimatePresence>
      {openTopic && createPortal(
        <TopicSheet key={openTopic} node={openTopic} onClose={() => setOpenTopic(null)} onJump={jump} />,
        times.ref.current?.closest('.assistant-shell') ?? document.body,
      )}
      {opened && createPortal(
        <BackgroundRunDialog key={openRun} run={opened} onClose={() => setOpenRun(null)} />,
        times.ref.current?.closest('.assistant-shell') ?? document.body,
      )}
    </Motion.div>
  );
});
