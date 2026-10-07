import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react';
import { FooterBodySession, FooterEvent } from './independent-footer-protocol';
import { retireRootReader } from './root-scroll-trial';
import type { FooterActionName, FooterPropsValue, FooterReply, FooterEventValue } from './independent-footer-protocol';
import { independentFooterEnabled, postFooter } from './independent-footer-transport';
import './independent-footer.css';
import { receiveFooterErrors } from './footer-error-channel';
type Activation = Extract<FooterEventValue, { kind: 'activate' }>;
export function useIndependentFooter(value: Readonly<{ scope: string; visible: boolean; props: Omit<FooterPropsValue, 'scheme'> }>,
  action: (name: FooterActionName, draftId?: string) => Promise<FooterReply>) {
  const enabled = independentFooterEnabled();
  const latest = useRef(action); latest.current = action;
  const session = useMemo(() => new FooterBodySession((name, id) => latest.current(name, id)), []);
  useLayoutEffect(() => enabled ? receiveFooterErrors(session.document) : undefined, [enabled, session]);
  const [activation, setActivation] = useState<Activation | null>(null);
  const [failed, setFailed] = useState(false);
  const [modal, setModal] = useState(false);
  const [scheme, setScheme] = useState<'light' | 'dark'>(() => matchMedia('(prefers-color-scheme: dark)').matches ? 'dark' : 'light');
  const fallback = useCallback((notify: boolean) => {
    session.footerDocument = undefined; setActivation(null); setFailed(true);
    retireRootReader('footer');
    if (notify) void postFooter({ v: 1, kind: 'fallback', document: session.document });
  }, [session]);
  const visible = value.visible && !modal && !document.querySelector('dialog[open]');
  const active = enabled && !failed && visible && activation?.scope === value.scope;
  useLayoutEffect(() => {
    if (!enabled) return;
    const receive = async (input: unknown): Promise<FooterReply> => {
      const parsed = FooterEvent.safeParse(input);
      const reply = await session.handle(input);
      if (reply.ok && parsed.success && parsed.data.revision === session.acceptedRevision
        && parsed.data.scope === session.state?.scope && parsed.data.generation === session.state.generation) {
        if (parsed.data.kind === 'activate') setActivation(parsed.data);
        else if (parsed.data.kind === 'fallback') fallback(false);
      }
      return reply;
    };
    window.__assistantFooterEvent = receive;
    const event = (input: Event) => {
      if (!(input instanceof CustomEvent)) return;
      const parsed = FooterEvent.safeParse(input.detail);
      if (parsed.success && parsed.data.kind === 'fallback') void receive(parsed.data);
    };
    window.addEventListener('assistant-footer-fallback', event);
    return () => {
      window.removeEventListener('assistant-footer-fallback', event);
      if (window.__assistantFooterEvent === receive) delete window.__assistantFooterEvent;
      void postFooter({ v: 1, kind: 'fallback', document: session.document });
    };
  }, [enabled, session, fallback]);
  useLayoutEffect(() => {
    if (!enabled || failed) return;
    try {
      const packet = session.update({ ...value, visible: Boolean(visible), props: { ...value.props, scheme } });
      if (packet) void postFooter(packet).then(reply => { if (!reply.ok && session.state?.generation === packet.generation) fallback(true); });
    } catch { fallback(true); }
  });
  useLayoutEffect(() => {
    if (!active || !activation || session.state?.generation !== activation.generation) return;
    const { kind: _kind, ...ids } = activation;
    void postFooter({ ...ids, kind: 'active' }).then(reply => {
      if (!reply.ok && session.acceptedRevision === activation.revision && session.state?.generation === activation.generation
        && session.state.scope === activation.scope && session.footerDocument === activation.footerDocument) fallback(true);
    });
  }, [active, activation, session, fallback]);
  useEffect(() => {
    if (!enabled) return;
    const observer = new MutationObserver(() => setModal(Boolean(document.querySelector('dialog[open]'))));
    observer.observe(document.body, { subtree: true, childList: true, attributes: true, attributeFilter: ['open'] });
    const media = matchMedia('(prefers-color-scheme: dark)'), change = () => setScheme(media.matches ? 'dark' : 'light');
    media.addEventListener('change', change);
    return () => { observer.disconnect(); media.removeEventListener('change', change); };
  }, [enabled]);
  return { active, error: failed ? '상태와 첨부 화면을 연결하지 못해 기본 대화 화면으로 돌아왔어요.' : '' };
}
