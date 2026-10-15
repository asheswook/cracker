import { useEffect, useLayoutEffect, useRef, useState, useSyncExternalStore } from 'react';
import { createPortal } from 'react-dom';
import { AnimatePresence, m as Motion } from 'motion/react';
import { AlertCircle, X } from 'lucide-react';
import { errorToasts } from './error-toasts';
import type { ErrorToastValue } from './error-toasts';
import { useReducedMotion } from './useReducedMotion';
import './error-toasts.css';

function Toast({ value }: { readonly value: ErrorToastValue }) {
  const [hovered, setHovered] = useState(false);
  const [focused, setFocused] = useState(false);
  const [expanded, setExpanded] = useState(false);
  const reduced = useReducedMotion();
  useEffect(() => {
    if (hovered || focused || expanded) return;
    const timer = setTimeout(() => errorToasts.dismiss(value.id), 8000);
    return () => clearTimeout(timer);
  }, [value.id, hovered, focused, expanded]);
  return <Motion.div className="error-toast" role="alert" initial={{ opacity: 0, y: reduced ? 0 : 8 }}
    animate={{ opacity: 1, y: 0 }} exit={{ opacity: 0, y: reduced ? 0 : 4 }} transition={{ duration: reduced ? 0.1 : 0.18 }}
    onPointerEnter={() => setHovered(true)} onPointerLeave={() => setHovered(false)}
    onFocusCapture={() => setFocused(true)} onBlurCapture={event => { if (!(event.relatedTarget instanceof Node) || !event.currentTarget.contains(event.relatedTarget)) setFocused(false); }}>
    <AlertCircle size={18} aria-hidden="true" />
    <div className="error-toast-content"><p className={expanded ? 'expanded' : ''}>{value.message}</p>
      {value.message.length > 140 && <button type="button" className="error-toast-details" aria-expanded={expanded} onClick={() => setExpanded(value => !value)}>{expanded ? '접기' : '자세히'}</button>}
      {value.action && <button type="button" className="error-toast-action" onClick={() => { value.action?.run(); errorToasts.dismiss(value.id); }}>{value.action.label}</button>}
    </div>
    <button type="button" className="error-toast-dismiss" aria-label="오류 알림 닫기" onClick={() => errorToasts.dismiss(value.id)}><X size={16} aria-hidden="true" /></button>
  </Motion.div>;
}

export function ErrorToasts() {
  const items = useSyncExternalStore(errorToasts.subscribe, errorToasts.snapshot);
  const host = useRef<HTMLDivElement>(null);
  const latest = useRef(items); latest.current = items;
  const popover = typeof HTMLElement !== 'undefined' && 'showPopover' in HTMLElement.prototype;
  const [target, setTarget] = useState<Element>(document.body);
  useLayoutEffect(() => {
    const update = () => {
      const dialogs = document.querySelectorAll('dialog[open]');
      setTarget(dialogs.item(dialogs.length - 1) ?? document.body);
    };
    const observer = new MutationObserver(update);
    observer.observe(document.body, { subtree: true, childList: true, attributes: true, attributeFilter: ['open'] });
    update();
    return () => observer.disconnect();
  }, []);
  useLayoutEffect(() => {
    const node = host.current;
    if (items.length && node && popover && !node.matches(':popover-open')) node.showPopover();
  }, [items, popover, target]);
  return createPortal(<div ref={host} className="error-toast-host" popover={popover ? 'manual' : undefined} aria-label="오류 알림">
    <AnimatePresence onExitComplete={() => { if (!latest.current.length && popover) host.current?.hidePopover(); }}>
      {items.map(value => <Toast key={value.id} value={value} />)}
    </AnimatePresence>
  </div>, target);
}
