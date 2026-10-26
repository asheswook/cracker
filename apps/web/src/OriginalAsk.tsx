import { useEffect, useRef, useState } from 'react';
import { errorMessage } from './api';
import { Id } from './types';
import { WorkNavigationError } from './WorkOpenAction';
import './original-ask.css';

/** "원래 부탁 보기" in an opened 예약 row: back to the message where the user asked for it. */
export function OriginalAskLink({ conversation, message, onOpen }: {
  readonly conversation?: string | null | undefined;
  readonly message?: string | null | undefined;
  readonly onOpen?: ((conversation: Id, message: Id) => Promise<void> | void) | undefined;
}) {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const mounted = useRef(true);
  useEffect(() => { mounted.current = true; return () => { mounted.current = false; }; }, []);
  if (!onOpen || !conversation || !message) return null;
  const go = async () => {
    setBusy(true); setError('');
    try { await onOpen(Id.parse(conversation), Id.parse(message)); }
    catch (e) { if (mounted.current) setError(e instanceof WorkNavigationError ? e.message : errorMessage(e)); }
    finally { if (mounted.current) setBusy(false); }
  };
  return (
    <span className="original-ask">
      <button type="button" onClick={() => void go()} disabled={busy} aria-busy={busy || undefined}>{busy ? '여는 중…' : '원래 부탁 보기'}</button>
      {error && <span className="original-ask-error" role="alert">{error}</span>}
    </span>
  );
}
