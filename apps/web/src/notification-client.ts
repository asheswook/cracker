import { z } from 'zod';
import { http, read } from './api';
import { isNativeApp } from './native-bridge';
import {
  disableNativeNotifications,
  enableNativeNotifications,
  refreshNativeNotifications,
} from './native-notifications';

const Status = z.object({ configured: z.boolean(), public_key: z.string().nullable(), enabled: z.boolean(), show_content: z.boolean() });
export type NotificationStatus = z.infer<typeof Status>;
export function installationId(): string {
  const saved = localStorage.getItem('assistant.notification-installation');
  if (saved && z.uuid().safeParse(saved).success) return saved;
  const id = crypto.randomUUID();
  localStorage.setItem('assistant.notification-installation', id);
  return id;
}
export function notificationSupport(): boolean {
  return (
    isNativeApp() ||
    (window.isSecureContext &&
      'serviceWorker' in navigator &&
      'PushManager' in window &&
      'Notification' in window)
  );
}
export async function notificationStatus() {
  if (isNativeApp()) return (await refreshNativeNotifications()).server;
  return read(`/v1/notifications?installation_id=${installationId()}`, Status);
}
export async function enableNotifications(publicKey: string | null): Promise<NotificationPermission> {
  if (isNativeApp()) return enableNativeNotifications();
  if (!publicKey) return 'default';
  // Invoke only inside the user's click handler, before any awaited operation.
  const permission = await Notification.requestPermission();
  if (permission !== 'granted') return permission;
  const registration = await navigator.serviceWorker.register('/notification-sw.js', { scope: '/' });
  await navigator.serviceWorker.ready;
  const bytes = Uint8Array.from(
    atob(publicKey.replaceAll('-', '+').replaceAll('_', '/') + '='.repeat((4 - (publicKey.length % 4)) % 4)),
    (char) => char.charCodeAt(0),
  );
  let subscription = await registration.pushManager.getSubscription();
  const prior = subscription?.options.applicationServerKey;
  if (
    subscription &&
    ((subscription.expirationTime !== null && subscription.expirationTime <= Date.now()) ||
      !prior ||
      BufferlessKey(prior) !== BufferlessKey(bytes))
  ) {
    await subscription.unsubscribe();
    subscription = null;
  }
  subscription ??= await registration.pushManager.subscribe({
    userVisibleOnly: true,
    applicationServerKey: bytes,
  });
  await http.put('/v1/notifications/subscription', {
    json: { installation_id: installationId(), subscription: subscription.toJSON() },
  });
  window.dispatchEvent(new Event('assistant-notification-subscription'));
  return permission;
}
export async function disableNotifications(): Promise<void> {
  if (isNativeApp()) return disableNativeNotifications();
  await http.delete(`/v1/notifications/subscription/${installationId()}`);
  const registration = await navigator.serviceWorker.getRegistration('/notification-sw.js');
  await (await registration?.pushManager.getSubscription())?.unsubscribe();
  window.dispatchEvent(new Event('assistant-notification-subscription'));
}

function BufferlessKey(value: ArrayBuffer | Uint8Array): string {
  return Array.from(value instanceof Uint8Array ? value : new Uint8Array(value)).join(',');
}

export async function localNotificationSubscription(): Promise<boolean> {
  if (isNativeApp()) {
    const { device } = await refreshNativeNotifications();
    return device.configured && device.permission === 'granted' && !!device.token;
  }
  if (!notificationSupport()) return false;
  const registration = await navigator.serviceWorker.getRegistration('/notification-sw.js');
  const subscription = await registration?.pushManager.getSubscription();
  return !!subscription && (subscription.expirationTime == null || subscription.expirationTime > Date.now());
}

export async function saveNotificationPreference(showContent: boolean): Promise<boolean> {
  const result = await http.put('/v1/notifications/preferences', { json: { show_content: showContent } }).json();
  return z.object({ show_content: z.boolean() }).parse(result).show_content;
}
