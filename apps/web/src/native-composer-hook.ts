import { useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react';
import { NativeComposerController } from './native-composer';
import type { ComposerBinding, ComposerResponse, NativeComposerState } from './native-composer';
import { connectComposer, postComposer as post } from './native-composer-transport';
import './native-composer.css';

declare global {
  interface Window { __assistantComposer?: (command: unknown) => ComposerResponse | Promise<ComposerResponse> }
}
export function useNativeComposer(workspace: string | null, binding: ComposerBinding) {
  const [active, setActive] = useState(false);
  const [modal, setModal] = useState(false);
  const [, setAppearance] = useState(0);
  const focus = useRef(0);
  const bindingRef = useRef(binding);
  bindingRef.current = binding;
  const transport = useRef<(state: NativeComposerState) => void>(() => {});
  const controller = useMemo(() => new NativeComposerController(state => transport.current(state)), [workspace]);
  const publish = () => {
    const state = controller.snapshot();
    if (state) transport.current(state);
  };
  useLayoutEffect(() => {
    const source = bindingRef.current;
    controller.bind({ ...source, state: () => {
      const state = source.state();
      const obscured = modal || Boolean(document.querySelector('dialog[open]'));
      return { ...state, visible: state.visible && !obscured, focus: focus.current };
    } });
    publish();
  });
  useEffect(() => {
    let alive = true;
    let connected = false;
    let connecting = false;
    let epoch = 0;
    let dirty = false;
    let resumeConnect = false;
    const pending = new Set<object>();
    const visible = () => document.visibilityState !== 'hidden';
    controller.activate();
    setActive(false);
    const hide = () => {
      const state = controller.snapshot();
      if (state && visible()) void post({ method: 'composerHide', document: controller.document, session: state.session }).catch(() => { /* Fallback remains usable if an older host rejects hide. */ });
    };
    const fail = () => {
      connected = false;
      resumeConnect = false;
      setActive(false);
      hide();
    };
    const send = (state: NativeComposerState) => {
      if (!alive) return;
      if (!visible() || connecting) { dirty = true; return; }
      if (!connected) return;
      dirty = false;
      const token = {};
      const sentEpoch = epoch;
      pending.add(token);
      void post({ method: 'composerState', state }).catch(() => {
        if (!alive || sentEpoch !== epoch || controller.identity()?.session !== state.session) return;
        if (!visible()) { resumeConnect = true; connected = false; return; }
        fail();
      }).finally(() => pending.delete(token));
    };
    const connect = () => {
      if (!workspace || !window.webkit?.messageHandlers?.assistantNative) return;
      if (!visible()) { resumeConnect = true; return; }
      const attempt = ++epoch;
      connecting = true;
      resumeConnect = false;
      const session = controller.identity()?.session;
      const lifecycleCurrent = () => alive && attempt === epoch && visible();
      const current = () => lifecycleCurrent() && controller.identity()?.session === session;
      const settle = () => {
        if (!lifecycleCurrent()) return false;
        if (controller.identity()?.session !== session) { connect(); return false; }
        return true;
      };
      void connectComposer(controller, current).then(ready => {
        if (!settle()) return;
        connecting = false;
        if (!ready) { fail(); return; }
        connected = true;
        setActive(true);
        const latest = controller.snapshot();
        if (latest) send(latest);
      }).catch(() => {
        if (!settle()) return;
        connecting = false;
        fail();
      });
    };
    const visibilityChanged = () => {
      if (!visible()) {
        // A request that crossed suspension cannot decide ownership after a new handshake.
        resumeConnect ||= connecting || pending.size > 0;
        if (resumeConnect) connected = false;
        connecting = false;
        epoch += 1;
        pending.clear();
      } else if (resumeConnect) connect();
      else if (dirty && connected) {
        const latest = controller.snapshot();
        if (latest) send(latest);
      }
    };
    transport.current = send;
    window.__assistantComposer = controller.handle;
    document.addEventListener('visibilitychange', visibilityChanged);
    connect();
    return () => {
      alive = false;
      epoch += 1;
      connected = false;
      document.removeEventListener('visibilitychange', visibilityChanged);
      if (transport.current === send) transport.current = () => {};
      if (window.__assistantComposer === controller.handle) delete window.__assistantComposer;
      hide();
      controller.deactivate();
    };
  }, [controller, workspace]);
  useEffect(() => {
    const observer = new MutationObserver(() => setModal(Boolean(document.querySelector('dialog[open]'))));
    observer.observe(document.body, { subtree: true, childList: true, attributes: true, attributeFilter: ['open'] });
    const media = matchMedia('(prefers-color-scheme: dark)');
    const changed = () => setAppearance(value => value + 1);
    media.addEventListener('change', changed);
    return () => { observer.disconnect(); media.removeEventListener('change', changed); };
  }, []);
  return { active, identity: () => controller.identity(), focus: () => {
    if (!active) return false;
    if (document.visibilityState === 'hidden' || !bindingRef.current.state().visible || document.querySelector('dialog[open]')) return true;
    focus.current += 1;
    publish();
    return true;
  } };
}

export function composerTheme(element: Element | null): NativeComposerState['theme'] {
  const styles = getComputedStyle(element ?? document.documentElement);
  const color = (token: string, fallback: string) => {
    const value = styles.getPropertyValue(token).trim();
    if (/^#[0-9a-f]{6}$/i.test(value)) return value;
    if (/^#[0-9a-f]{3}$/i.test(value)) return `#${[...value.slice(1)].map(char => char + char).join('')}`;
    return fallback;
  };
  return { canvas: color('--message-canvas', '#fcfcfc'), surface: color('--message-composer', '#ffffff'),
    ink: color('--message-ink', '#0d0d0d'), muted: color('--message-secondary', '#8f8f8f'), accent: color('--message-sent', '#fa7002') };
}
