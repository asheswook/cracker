import { type Dispatch, type SetStateAction, useEffect, useState } from 'react';
import { errorMessage } from './api';
import { isNativeApp, listenNativeResults, NativeBridgeError } from './native-bridge';
import { refreshNativeNotifications } from './native-notifications';

type ResultTarget = { readonly href: string; readonly revision: number };
export function useNativeApp(
  connected: boolean,
  setResultTarget: Dispatch<SetStateAction<ResultTarget>>,
  setError: Dispatch<SetStateAction<string>>,
): string {
  const [refreshError, setRefreshError] = useState('');
  useEffect(
    () =>
      listenNativeResults(
        (href) => setResultTarget((current) => ({ href, revision: current.revision + 1 })),
        (error) => setError(error instanceof NativeBridgeError ? error.message : errorMessage(error)),
      ),
    [setResultTarget, setError],
  );
  useEffect(() => {
    if (!isNativeApp() || !connected) return;
    let active = true;
    let running = false;
    let pending = false;
    const refresh = async () => {
      pending = true;
      if (running) return;
      running = true;
      try {
        while (pending && active) {
          pending = false;
          try {
            await refreshNativeNotifications();
            if (active) setRefreshError('');
          } catch (error) {
            if (active)
              setRefreshError(error instanceof NativeBridgeError ? error.message : errorMessage(error));
          }
        }
      } finally {
        running = false;
      }
    };
    const receive = () => void refresh();
    const visibility = () => {
      if (document.visibilityState === 'visible') receive();
    };
    window.addEventListener('assistant-native-notification-state', receive);
    window.addEventListener('focus', receive);
    document.addEventListener('visibilitychange', visibility);
    receive();
    return () => {
      active = false;
      window.removeEventListener('assistant-native-notification-state', receive);
      window.removeEventListener('focus', receive);
      document.removeEventListener('visibilitychange', visibility);
    };
  }, [connected]);
  return connected ? refreshError : '';
}
