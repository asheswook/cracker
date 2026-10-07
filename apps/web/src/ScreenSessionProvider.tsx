import { createContext, useContext, useLayoutEffect, useMemo, useRef } from 'react';
import type { ReactNode } from 'react';
import { ScreenSession } from './screen-session';
const ScreenContext = createContext<ScreenSession | null>(null);
export function ScreenSessionProvider({ workspace, vmId, connected, visible, controlAllowed, children }: Readonly<{
  workspace: string | null; vmId: string | undefined; connected: boolean; visible: boolean; controlAllowed: boolean; children: ReactNode;
}>) {
  const session = useMemo(() => workspace && vmId ? new ScreenSession(vmId, location.href) : null, [workspace, vmId]);
  const current = useRef({ connected, visible, controlAllowed }); current.current = { connected, visible, controlAllowed };
  const pageActive = useRef(true);
  const update = () => session?.configure({ foreground: current.current.connected && pageActive.current && document.visibilityState === 'visible',
    visible: current.current.visible, controlAllowed: current.current.controlAllowed });
  useLayoutEffect(update);
  useLayoutEffect(() => {
    const changed = () => update();
    const hide = () => { pageActive.current = false; session?.suspend(); };
    const show = () => { pageActive.current = true; update(); };
    document.addEventListener('visibilitychange', changed);
    window.addEventListener('pagehide', hide); window.addEventListener('pageshow', show);
    return () => {
      document.removeEventListener('visibilitychange', changed);
      window.removeEventListener('pagehide', hide); window.removeEventListener('pageshow', show);
      session?.suspend();
    };
  }, [session]);
  return <ScreenContext.Provider value={session}>{children}</ScreenContext.Provider>;
}
export function useScreenSession() { return useContext(ScreenContext); }
