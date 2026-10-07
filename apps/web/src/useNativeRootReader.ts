import { useCallback, useEffect, useLayoutEffect, useMemo, useState } from 'react';
import type { RefObject } from 'react';
import { RootReaderAdapter } from './native-reader-adapter';
import type { ReaderInput } from './native-reader-adapter';
import { readerDOM } from './native-reader-dom';
import { postReader } from './native-reader-transport';
import { rootReaderAvailable, setRootScrollActive } from './root-scroll-trial';
export function useNativeRootReader(input: ReaderInput & { workspace: string | null }, feed: RefObject<HTMLElement | null>) {
  const [active, setActive] = useState(false);
  const [unread, setUnread] = useState(false);
  const [awayFromLatest, setAwayFromLatest] = useState(false);
  const [fallback, setFallback] = useState(0);
  const [modal, setModal] = useState(false);
  const adapter = useMemo(() => new RootReaderAdapter(readerDOM(() => feed.current), postReader, {
    active: value => { setRootScrollActive(value); setActive(value); }, unread: setUnread, awayFromLatest: setAwayFromLatest,
    fallback: () => setFallback(value => value + 1),
  }), [input.workspace, feed]);
  useLayoutEffect(() => {
    if (!rootReaderAvailable()) return;
    const receive = (value: unknown) => ({ ok: adapter.session.receive(value) });
    window.__assistantReaderEvent = receive;
    const disable = (event: Event) => adapter.disable(!(event instanceof CustomEvent && ['footer', 'header'].includes(event.detail)));
    window.addEventListener('assistant-root-reader-disable', disable);
    return () => { window.removeEventListener('assistant-root-reader-disable', disable); if (window.__assistantReaderEvent === receive) delete window.__assistantReaderEvent; adapter.dispose(); };
  }, [adapter]);
  useLayoutEffect(() => {
    if (rootReaderAvailable() && (window.visualViewport?.scale ?? 1) === 1) adapter.configure({ ...input, suspended: input.suspended || modal || Boolean(document.querySelector('dialog[open]')) });
  });
  useLayoutEffect(() => {
    const node = feed.current;
    if (!active || !node) return;
    const observer = new ResizeObserver(() => adapter.checkpoint());
    observer.observe(node); observer.observe(document.documentElement);
    const changed = () => adapter.checkpoint();
    window.addEventListener('assistant-panel-source-request', changed);
    window.addEventListener('resize', changed);
    window.addEventListener('scroll', changed, { passive: true });
    return () => { observer.disconnect(); window.removeEventListener('assistant-panel-source-request', changed); window.removeEventListener('resize', changed); window.removeEventListener('scroll', changed); };
  }, [active, adapter, feed]);
  useEffect(() => {
    const observer = new MutationObserver(() => setModal(Boolean(document.querySelector('dialog[open]'))));
    observer.observe(document.body, { subtree: true, childList: true, attributes: true, attributeFilter: ['open'] });
    return () => observer.disconnect();
  }, []);
  const latest = useCallback(() => adapter.latest(), [adapter]);
  return { active, unread, awayFromLatest: active && input.selected && !input.suspended && !modal && awayFromLatest, fallback, latest };
}
