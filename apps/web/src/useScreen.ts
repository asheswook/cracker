import { useLayoutEffect, useMemo, useRef, useSyncExternalStore } from 'react';
import { useScreenSession } from './ScreenSessionProvider';
import type { ScreenSnapshot } from './screen-session';
export type { ScreenPhase } from './screen-session';
const unavailable: ScreenSnapshot = { state: '컴퓨터 연결을 기다리고 있어요.', phase: 'waiting', open: false,
  inputStatus: '', held: false, claiming: false, inputGeneration: 0, protocol: 'pending', visible: false };
const idleSubscribe = () => () => {};
const idleSnapshot = () => unavailable;
const ignore = () => {};
export function useScreen() {
  const session = useScreenSession();
  const video = useRef<HTMLVideoElement>(null);
  const snapshot = useSyncExternalStore(session?.subscribe ?? idleSubscribe, session?.getSnapshot ?? idleSnapshot);
  const send = useMemo(() => session?.sender() ?? ignore, [session, snapshot.inputGeneration]);
  useLayoutEffect(() => {
    session?.attachVideo(video.current);
    return () => session?.attachVideo(null);
  }, [session]);
  return { ...snapshot, video, live: snapshot.phase === 'live', send,
    reconnect: session?.reconnect ?? ignore, claim: session?.claim ?? ignore, release: session?.release ?? ignore,
    onRevoke: session?.onRevoke ?? idleSubscribe };
}
