import { memo, useContext, useLayoutEffect, useMemo, useRef, useState } from 'react';
import { MessageTimeControl } from './MessageTimeControl';
import { HeaderTimeContext } from './header-time-context';
import { AnimatePresence, m as Motion } from 'motion/react';
import { createPortal } from 'react-dom';
import { RefreshCw } from 'lucide-react';
import type { Message, Pending } from './types';
import { Attachments } from './Attachments';
import { MessageBubble } from './MessageBubble';
import { SystemEvent } from './SystemEvent';
import { systemMessageContent } from './system-message';
import { dayDividers } from './feed-labels';
import { client } from './store';
import { useMessageTimeReveal } from './useMessageTimeReveal';
import './message-time-reveal.css';

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
  assistantName = 'Assistant',
  timeControlRoot = null,
  keep = null,
}: {
  messages: Message[];
  pending: Pending[];
  reduced: boolean | null;
  arrivals: ReadonlySet<string>;
  assistantName?: string;
  timeControlRoot?: HTMLElement | null;
  keep?: string | null;
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
          ...visibleMessages.flatMap((m, index) => {
            const systemContent = systemMessageContent(m);
            if (systemContent === null) return [];
            const previous = visibleMessages[index - 1];
            const newDay = dividers.has(m.id);
            return [
              ...(newDay ? [<DayDivider key={`day-${m.id}`} date={m.created_at} />] : []),
              <Motion.article
                key={m.client_message_id ?? m.id}
                id={`message-${m.id}`}
                data-task-id={m.task_id ?? undefined}
                className={`message ${m.role} ${!newDay && previous?.role === m.role ? 'same-speaker' : 'new-speaker'}`}
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
                ) : (
                  <MessageBubble role={m.role} content={m.content} />
                )}
                <Attachments items={m.attachments} />
                <time className="message-time" dateTime={m.created_at}>
                  {new Date(m.created_at).toLocaleTimeString('ko-KR', {
                    hour: 'numeric',
                    minute: '2-digit',
                  })}
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
    </Motion.div>
  );
});
