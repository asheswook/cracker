import { createContext, useContext, useEffect, useRef, useState } from 'react';
import { CornerUpLeft } from 'lucide-react';
import { TaskNavigation } from '../../../packages/protocol/task-navigation';
import { http, errorMessage } from './api';
import { Id } from './types';
import { WorkNavigationError } from './WorkOpenAction';
import './original-ask.css';

/** Opens a message in its conversation and highlights it (App's work navigation). Null where navigation is not available. */
export const SourceNavigation = createContext<((conversation: Id, message: Id) => Promise<void>) | null>(null);

/** The user's message behind a scheduled or routine run, from the task's navigation (fetched on tap). */
async function originalAsk(task: string) {
  const target = TaskNavigation.parse(await http.get(`/v1/tasks/${task}/navigation`).json<unknown>());
  return target.source ? { conversation: Id.parse(target.source.conversation_id), message: Id.parse(target.source.message_id) } : null;
}

const NOT_FOUND = '원래 부탁을 찾을 수 없어요';

/**
 * "원래 부탁 보기": one quiet text link from a reminder or a routine run to what the user asked for.
 * Either a task (its source is looked up on tap) or a known message. Hidden where navigation is unavailable.
 */
export function OriginalAskLink({ task, conversation, message, onOpened, className = '' }: {
  readonly task?: string | null | undefined;
  readonly conversation?: string | null | undefined;
  readonly message?: string | null | undefined;
  readonly onOpened?: (() => void) | undefined;
  readonly className?: string;
}) {
  const open = useContext(SourceNavigation);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const mounted = useRef(true);
  useEffect(() => { mounted.current = true; return () => { mounted.current = false; }; }, []);
  if (!open || (!task && !(conversation && message))) return null;
  const go = async () => {
    setBusy(true); setError('');
    try {
      const target = conversation && message ? { conversation: Id.parse(conversation), message: Id.parse(message) } : await originalAsk(task!);
      if (!target) { if (mounted.current) setError(NOT_FOUND); return; }
      onOpened?.();
      await open(target.conversation, target.message);
    } catch (e) {
      if (mounted.current) setError(e instanceof WorkNavigationError ? e.message : errorMessage(e));
    } finally { if (mounted.current) setBusy(false); }
  };
  return (
    <span className={`original-ask ${className}`}>
      <button type="button" className="original-ask-link" onClick={() => void go()} disabled={busy} aria-busy={busy || undefined}>
        <CornerUpLeft size={13} aria-hidden="true" />{busy ? '여는 중…' : '원래 부탁 보기'}
      </button>
      {error && <span className="original-ask-error" role="alert">{error}</span>}
    </span>
  );
}
