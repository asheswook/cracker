import { useEffect, useRef } from 'react';
import { ArrowDown } from 'lucide-react';

export function LatestButton({ onLatest }: { readonly onLatest: () => void }) {
  const action = useRef(onLatest); action.current = onLatest;
  const press = useRef<{ id: number; x: number; y: number; cancelled: boolean; fired: boolean } | null>(null);
  const timer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);
  const consumed = useRef(false);
  const cancel = () => { clearTimeout(timer.current); if (press.current) press.current.cancelled = true; };
  const activate = () => { const current = press.current; if (current && !current.cancelled && !current.fired) { current.fired = true; action.current(); } };
  useEffect(() => () => clearTimeout(timer.current), []);
  return <button type="button" className="new-message" aria-label="최신 메시지" title="최신 메시지"
    onPointerDown={event => {
      if (!event.isPrimary || event.button !== 0) return;
      consumed.current = true;
      press.current = { id: event.pointerId, x: event.clientX, y: event.clientY, cancelled: false, fired: false };
      timer.current = setTimeout(activate, 80);
    }}
    onPointerMove={event => {
      const current = press.current;
      if (current?.id === event.pointerId && Math.hypot(event.clientX - current.x, event.clientY - current.y) > 8) cancel();
    }}
    onPointerLeave={cancel} onPointerCancel={cancel}
    onPointerUp={event => { if (press.current?.id !== event.pointerId) return; clearTimeout(timer.current); activate(); press.current = null; }}
    onClick={event => { if (event.detail === 0 || !consumed.current) action.current(); consumed.current = false; }}>
    <ArrowDown size={20} aria-hidden="true" />
  </button>;
}
