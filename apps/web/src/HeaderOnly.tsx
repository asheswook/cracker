import { useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { ArchiveBanner } from './ArchiveBanner';
import { ConversationHeader } from './ConversationHeader';
import { MessageTimeControl } from './MessageTimeControl';
import { HeaderRenderSession } from './independent-header-protocol';
import type { HeaderActionName, HeaderRenderValue } from './independent-header-protocol';
import { postHeader } from './independent-header-transport';
import './assistant.css';
import './messenger.css';
import './message-time-reveal.css';
import './independent-header.css';
const headerDocument = crypto.randomUUID();
export function HeaderOnly() {
  const receiver = useMemo(() => new HeaderRenderSession(headerDocument), []);
  const [state, setState] = useState<HeaderRenderValue | null>(null);
  const latest = useRef<HeaderRenderValue | null>(null);
  const surface = useRef<HTMLDivElement>(null);
  const [timeRoot, setTimeRoot] = useState<HTMLDivElement | null>(null);
  const failed = useRef(false);
  const action = (name: HeaderActionName) => {
    const current = latest.current;
    if (!current?.visible || failed.current) return;
    void postHeader({ v: 1, kind: 'action', document: headerDocument, mainDocument: current.document,
      scope: current.scope, generation: current.generation, commandId: crypto.randomUUID(), action: name }).catch(() => undefined);
    // Native restores the body on a current failure. Rejections never replay or poison later actions.
  };
  useLayoutEffect(() => {
    const render = (input: unknown) => {
      const parsed = receiver.receive(input);
      if (!parsed.ok) return parsed;
      const value = parsed.value;
      if (value.props.scheme !== (matchMedia('(prefers-color-scheme: dark)').matches ? 'dark' : 'light'))
        return { ok: false, error: 'theme_mismatch' };
      latest.current = value;
      failed.current = false;
      setState(value);
      return { ok: true };
    };
    window.__assistantHeaderRender = render;
    void postHeader({ v: 1, kind: 'ready', document: headerDocument }).catch(() => { if (!latest.current) failed.current = true; });
    return () => { if (window.__assistantHeaderRender === render) delete window.__assistantHeaderRender; };
  }, [receiver]);
  useLayoutEffect(() => {
    const main = surface.current;
    const header = main?.querySelector<HTMLElement>('.messenger-header');
    if (!main || !header || !state) return;
    let signature = '';
    let alive = true;
    const measure = () => {
      if (!alive || latest.current !== state) return;
      const headerBounds = header.getBoundingClientRect();
      const fadeHeight = Number.parseFloat(getComputedStyle(main, '::before').height);
      const banner = main.querySelector<HTMLElement>('.archive-banner');
      const intrinsicHeight = Math.max(headerBounds.bottom, banner?.getBoundingClientRect().bottom ?? 0, Number.isFinite(fadeHeight) ? fadeHeight : 0);
      const rects = [...main.querySelectorAll<HTMLButtonElement>('button')].flatMap(button => {
        const rect = button.getBoundingClientRect();
        const style = getComputedStyle(button);
        return rect.width > 0 && rect.height > 0 && style.visibility !== 'hidden' && style.display !== 'none' && style.pointerEvents !== 'none'
          ? [{ x: rect.x, y: rect.y, width: rect.width, height: rect.height }] : [];
      });
      const height = Math.max(intrinsicHeight, ...rects.map(rect => rect.y + rect.height));
      if (!Number.isFinite(height) || height <= 0 || height > 16_384 || rects.length > 16 || (window.visualViewport?.scale ?? 1) !== 1) return;
      const packet = { v: 1, kind: 'geometry', document: headerDocument, mainDocument: state.document,
        generation: state.generation, scope: state.scope, height, rects };
      const next = JSON.stringify(packet);
      if (next === signature) return;
      signature = next;
      void postHeader(packet).catch(() => { if (latest.current === state) failed.current = true; });
    };
    const observer = new ResizeObserver(measure);
    observer.observe(header);
    const banner = main.querySelector('.archive-banner');
    if (banner) observer.observe(banner);
    for (const button of main.querySelectorAll('button')) observer.observe(button);
    window.addEventListener('resize', measure);
    main.addEventListener('focusin', measure);
    main.addEventListener('focusout', measure);
    measure();
    void document.fonts.ready.then(measure);
    return () => { alive = false; observer.disconnect(); window.removeEventListener('resize', measure); main.removeEventListener('focusin', measure); main.removeEventListener('focusout', measure); };
  }, [state, timeRoot]);
  useEffect(() => {
    document.documentElement.dataset['headerOnly'] = 'true';
  }, []);
  if (!state) return null;
  return <div className="app-shell assistant-shell"><main className="main-surface" ref={surface}>
    <ConversationHeader name={state.props.name} appearance={state.props.appearance} archiveTitle={state.props.archiveTitle ?? undefined}
      connected={state.props.connected} working={state.props.working} computerOpen={state.props.computerOpen}
      onMenu={() => action('menu')} onSettings={() => action('settings')} onComputer={() => action('computer')}
      onTimeControlMount={setTimeRoot} />
    {state.props.archiveTitle !== null && <ArchiveBanner onReturn={() => action('archive-return')} />}
    {state.props.time.available && timeRoot && createPortal(
      <MessageTimeControl pinned={state.props.time.pinned} onToggle={() => action('time-toggle')} />, timeRoot)}
  </main></div>;
}
