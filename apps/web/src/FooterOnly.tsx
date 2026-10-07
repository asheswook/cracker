import { useLayoutEffect, useMemo, useRef, useState } from 'react';
import { Button, ErrorNotice } from './primitives';
import { FooterContents } from './FooterContents';
import { FooterRenderSession, benignFooterRejection } from './independent-footer-protocol';
import type { FooterActionName, FooterRenderValue } from './independent-footer-protocol';
import { postFooter } from './independent-footer-transport';
import { forwardFooterErrors } from './footer-error-channel';
import './assistant.css';
import './messenger.css';
import './independent-footer.css';
const footerDocument = crypto.randomUUID();
declare global { interface Window { readonly __ASSISTANT_LATEST_TRACE__?: boolean } }
function traceLatest(stage: number, target: EventTarget | null) {
  if (window.__ASSISTANT_LATEST_TRACE__ !== true || !(target instanceof Element) || !target.closest('.new-message')) return;
  void window.webkit?.messageHandlers?.assistantFooter?.postMessage({ v: 1, kind: 'diagnostic', stage }).catch(() => undefined);
}
export function FooterOnly() {
  const session = useMemo(() => new FooterRenderSession(footerDocument), []);
  const [state, setState] = useState<FooterRenderValue | null>(null);
  const latest = useRef<FooterRenderValue | null>(null);
  const content = useRef<HTMLDivElement>(null);
  const geometryRevision = useRef(0);
  const [error, setError] = useState('');
  const props = state?.props;
  useLayoutEffect(() => state ? forwardFooterErrors(state.document) : undefined, [state?.document]);
  const latestOnly = Boolean(props?.latest && !props.readOnly && !props.error && !props.storage.failed && !props.drafts.length && !error);
  useLayoutEffect(() => {
    document.documentElement.dataset['footerFloating'] = String(latestOnly);
    return () => { delete document.documentElement.dataset['footerFloating']; };
  }, [latestOnly]);
  const recover = (current: FooterRenderValue | null) => {
    if (current && latest.current !== current) return;
    setError('상태 화면의 연결을 복원하지 못했어요. 기본 화면으로 돌아가 주세요.');
    if (current) void postFooter({ v: 1, kind: 'fallback', document: footerDocument, mainDocument: current.document,
      scope: current.scope, generation: current.generation, reason: 'footer_transport_failed' });
  };
  const action = (name: FooterActionName, draftId?: string) => {
    const current = latest.current;
    if (!current?.visible) return;
    void postFooter({ v: 1, kind: 'action', document: footerDocument, mainDocument: current.document,
      generation: current.generation, scope: current.scope, commandId: crypto.randomUUID(), action: name,
      ...(draftId ? { draftId } : {}) }, true).then(reply => { if (!reply.ok && !benignFooterRejection(reply.error)) recover(current); });
  };
  useLayoutEffect(() => {
    const render = (input: unknown) => {
      const result = session.receive(input);
      if (!result.ok) return result;
      if (result.value.props.scheme !== (matchMedia('(prefers-color-scheme: dark)').matches ? 'dark' : 'light')) return { ok: false, error: 'theme_mismatch' };
      latest.current = result.value; setError(''); setState(result.value); return { ok: true };
    };
    window.__assistantFooterRender = render;
    void postFooter({ v: 1, kind: 'ready', document: footerDocument }).then(reply => { if (!reply.ok && !latest.current) recover(null); });
    return () => { if (window.__assistantFooterRender === render) delete window.__assistantFooterRender; };
  }, [session]);
  useLayoutEffect(() => {
    const node = content.current;
    if (!node || !state) return;
    let signature = '', alive = true;
    const measure = () => {
      if (!alive || latest.current !== state || (window.visualViewport?.scale ?? 1) !== 1) return;
      const rect = node.getBoundingClientRect();
      const width = window.innerWidth, intrinsicHeight = state.visible ? rect.height : 0;
      if (!Number.isFinite(intrinsicHeight) || intrinsicHeight < 0 || !Number.isFinite(width) || width <= 0) return;
      const controls = state.visible && latestOnly ? Array.from(node.querySelectorAll<HTMLElement>('.new-message'), control => {
        const bounds = control.getBoundingClientRect();
        return [bounds.x, bounds.y, bounds.width, bounds.height];
      }) : [];
      const next = JSON.stringify([state.generation, width, intrinsicHeight, controls]);
      if (signature === next) return;
      signature = next;
      void postFooter({ v: 1, kind: 'geometry', document: footerDocument, mainDocument: state.document, scope: state.scope,
        generation: state.generation, geometryRevision: ++geometryRevision.current, width, intrinsicHeight, controls }).then(reply => {
          if (!reply.ok && !benignFooterRejection(reply.error)) recover(state);
        });
    };
    const observer = new ResizeObserver(measure); observer.observe(node);
    window.addEventListener('resize', measure); measure(); void document.fonts.ready.then(measure);
    return () => { alive = false; observer.disconnect(); window.removeEventListener('resize', measure); };
  }, [state, latestOnly]);
  return <div className="app-shell assistant-shell footer-shell"><main className="main-surface footer-pane" aria-label="대화 상태와 첨부">
    <div className="footer-content" ref={content}
      onPointerDownCapture={event => traceLatest(1, event.target)}
      onPointerUpCapture={event => traceLatest(2, event.target)}
      onClickCapture={event => traceLatest(3, event.target)}
      onPointerCancelCapture={event => traceLatest(4, event.target)}
    >{error && <><ErrorNotice>{error}</ErrorNotice><Button type="button" onClick={() => recover(latest.current)}>기본 화면으로 돌아가기</Button></>}{state?.visible && <FooterContents value={state.props} action={action} />}</div>
  </main></div>;
}
