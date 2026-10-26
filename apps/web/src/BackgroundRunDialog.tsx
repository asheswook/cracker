import { useEffect, useId, useRef } from 'react';
import { X } from 'lucide-react';
import { BACKGROUND_RUN_PREFIX } from './background-message';
import type { BackgroundRun } from './background-message';
import { Attachments } from './Attachments';
import { MessageBubble } from './MessageBubble';
import { systemMessageContent } from './system-message';
import { IconButton } from './primitives';
import './background-run.css';

const stamp = new Intl.DateTimeFormat('ko-KR', { month: 'long', day: 'numeric', weekday: 'short', hour: 'numeric', minute: '2-digit' });

export function BackgroundRunDialog({ run, onClose }: { readonly run: BackgroundRun; readonly onClose: () => void }) {
  const ref = useRef<HTMLDialogElement>(null);
  const body = useRef<HTMLDivElement>(null);
  const id = useId();
  useEffect(() => {
    const dialog = ref.current;
    const trigger = document.activeElement instanceof HTMLElement ? document.activeElement : null;
    dialog?.showModal();
    body.current?.focus({ preventScroll: true });
    return () => {
      dialog?.close();
      trigger?.focus({ preventScroll: true });
    };
  }, []);
  return (
    <dialog
      ref={ref}
      className="settings-dialog background-run-dialog"
      aria-labelledby={id}
      onCancel={(event) => {
        event.preventDefault();
        event.stopPropagation();
        onClose();
      }}
      onClick={(event) => {
        if (event.target === event.currentTarget) onClose();
      }}
    >
      <header>
        <div className="background-run-heading">
          <h2 id={id}>{run.title}</h2>
          {run.at && <time dateTime={run.at}>{stamp.format(new Date(run.at))}</time>}
        </div>
        <IconButton label="닫기" onClick={onClose}>
          <X size={18} />
        </IconButton>
      </header>
      {/* Focus lands on the scrollable result, not the close button, so the sheet opens without a ring. */}
      <div ref={body} className="background-run-body" tabIndex={-1}>
        {run.messages.map((message) => {
          if (message.role === 'system') {
            const text = systemMessageContent(message);
            const wake = text === `${BACKGROUND_RUN_PREFIX}${run.title}`;
            return text && !wake ? <p key={message.id} className="background-run-note">{text}</p> : null;
          }
          return (
            <div key={message.id} className={`message ${message.role}`}>
              <MessageBubble role={message.role} content={message.content} />
              <Attachments items={message.attachments} />
            </div>
          );
        })}
        {!run.messages.some(message => message.role !== 'system') && <p className="background-run-note">아직 결과가 없어요.</p>}
      </div>
    </dialog>
  );
}
