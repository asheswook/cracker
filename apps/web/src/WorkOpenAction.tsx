import { useEffect, useRef, useState } from 'react';
import { Button } from './primitives';
import { errorMessage } from './api';

export class WorkNavigationError extends Error {}
export function WorkOpenAction({ onOpen, children }: {
  readonly onOpen: () => Promise<void> | void;
  readonly children: string;
}) {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const mounted = useRef(true);
  useEffect(() => { mounted.current = true; return () => { mounted.current = false; }; }, []);
  const open = async () => {
    setBusy(true);
    setError('');
    try { await onOpen(); }
    catch (error) {
      if (mounted.current) setError(error instanceof WorkNavigationError ? error.message : errorMessage(error));
    } finally { if (mounted.current) setBusy(false); }
  };
  return <div className="work-open-action">
    <Button className="link-button" busy={busy} onClick={() => void open()}>
      {busy ? '여는 중…' : error ? `${children} 다시 시도` : children}
    </Button>
    {error && <p role="alert">{error}</p>}
  </div>;
}
