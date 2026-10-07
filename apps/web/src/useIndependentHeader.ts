import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react';
import { HeaderBodySession, HeaderEvent } from './independent-header-protocol';
import { retireRootReader } from './root-scroll-trial';
import type { HeaderActionName, HeaderPropsValue, HeaderStateValue } from './independent-header-protocol';
import { independentHeaderEnabled, listenHeaderFallback, postHeader } from './independent-header-transport';
import type { HeaderTimeBinding } from './header-time-context';
export function useIndependentHeader(value: Readonly<{
  scope: string; visible: boolean; props: Omit<HeaderPropsValue, 'time' | 'scheme'>;
}>, actions: Readonly<Record<Exclude<HeaderActionName, 'time-toggle'>, () => void>>) {
  const [failed, setFailed] = useState(false);
  const enabled = independentHeaderEnabled() && !failed;
  const latest = useRef(actions); latest.current = actions;
  const timeBinding = useRef<HeaderTimeBinding | null>(null);
  const [time, setTime] = useState({ available: false, pinned: false });
  const registerTime = useCallback((binding: HeaderTimeBinding | null) => {
    timeBinding.current = binding;
    const next = { available: binding?.available ?? false, pinned: binding?.pinned ?? false };
    setTime(previous => previous.available === next.available && previous.pinned === next.pinned ? previous : next);
  }, []);
  const [activation, setActivation] = useState<{ headerDocument: string; generation: number; scope: string } | null>(null);
  const [modal, setModal] = useState(false);
  const [scheme, setScheme] = useState<'light' | 'dark'>(() => matchMedia('(prefers-color-scheme: dark)').matches ? 'dark' : 'light');
  const session = useMemo(() => new HeaderBodySession(action => {
    if (action === 'time-toggle') {
      if (!timeBinding.current?.available) return false;
      timeBinding.current.toggle(); return true;
    }
    latest.current[action](); return true;
  }), []);
  const fail = useCallback(() => {
    setFailed(true);
    retireRootReader('header');
    session.headerDocument = undefined;
    void postHeader({ v: 1, kind: 'fallback', document: session.document }).catch(() => { /* Native may already be unavailable; the body remains the usable fallback. */ });
    setActivation(null);
    console.warn('[native-header] Using canonical header after bridge failure.');
  }, [session]);
  const visible = value.visible && !modal && !document.querySelector('dialog[open]');
  const active = enabled && visible && activation?.scope === value.scope;
  useLayoutEffect(() => {
    if (!enabled) return;
    const receive = (input: unknown) => {
      const parsed = HeaderEvent.safeParse(input);
      const reply = session.handle(input);
      if (reply.ok && parsed.success) {
        if (parsed.data.kind === 'activate') {
          setActivation({ headerDocument: parsed.data.headerDocument, generation: parsed.data.generation, scope: parsed.data.scope });
        } else if (parsed.data.kind === 'fallback') {
          setFailed(true);
          retireRootReader('header');
          setActivation(null);
          console.warn('[native-header] Using canonical header after bridge failure.');
        }
      }
      return reply;
    };
    window.__assistantHeaderEvent = receive;
    const stopFallback = listenHeaderFallback(receive);
    return () => {
      stopFallback();
      if (window.__assistantHeaderEvent === receive) delete window.__assistantHeaderEvent;
      session.headerDocument = undefined;
    };
  }, [enabled, session, fail]);
  useEffect(() => {
    if (!enabled || !visible || active) return;
    const timer = setTimeout(fail, 5000);
    return () => clearTimeout(timer);
  }, [enabled, visible, active, value.scope, fail]);
  useLayoutEffect(() => {
    if (!enabled) return;
    let packet: HeaderStateValue | undefined;
    try { packet = session.update({ ...value, visible: Boolean(visible), props: { ...value.props, scheme, time } }); }
    catch {
      fail();
      const previous = session.state;
      if (previous?.visible) {
        const hidden = session.update({ scope: previous.scope, visible: false, props: previous.props });
        if (hidden) void postHeader(hidden).catch(fail);
      }
      return;
    }
    if (packet) {
      const generation = packet.generation;
      void postHeader(packet).catch(() => { if (session.state?.generation === generation) fail(); });
    }
  });
  useLayoutEffect(() => {
    if (!active || !activation || !session.state || activation.generation !== session.state.generation) return;
    void postHeader({ v: 1, kind: 'active', document: session.document, ...activation }).catch(fail);
  }, [active, activation, session, fail]);
  useEffect(() => {
    if (!enabled) return;
    const observer = new MutationObserver(() => setModal(Boolean(document.querySelector('dialog[open]'))));
    observer.observe(document.body, { subtree: true, childList: true, attributes: true, attributeFilter: ['open'] });
    const media = matchMedia('(prefers-color-scheme: dark)');
    const changed = () => setScheme(media.matches ? 'dark' : 'light');
    media.addEventListener('change', changed);
    return () => { observer.disconnect(); media.removeEventListener('change', changed); };
  }, [enabled]);
  return { active, error: '', registerTime };
}
