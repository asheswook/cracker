import { useEffect } from 'react';
import { isNativeApp, nativeNotificationAttention } from './native-bridge';
import { installationId } from './notification-client';
import { observeNotificationAttention } from './notification-attention';

export function useNotificationAttention(connected: boolean, refresh: () => void, conversation: string | null): void {
  useEffect(() => {
    if (!connected || !conversation) return;
    const native = isNativeApp();
    const stop = observeNotificationAttention(installationId(), undefined, {
      conversation, ...(native ? { nativeAttention: nativeNotificationAttention } : {}),
    });
    if (native) window.addEventListener('assistant-native-notification', refresh);
    return () => {
      stop();
      if (native) window.removeEventListener('assistant-native-notification', refresh);
    };
  }, [connected, refresh, conversation]);
}
