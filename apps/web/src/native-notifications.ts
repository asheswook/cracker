import { z } from 'zod';
import { http, read } from './api';
import { type NativeNotificationState, nativeNotificationState } from './native-bridge';

const Status = z.object({ configured: z.boolean(), public_key: z.string().nullable(), enabled: z.boolean(), show_content: z.boolean() });
export type NativeNotificationSnapshot = {
  readonly device: NativeNotificationState;
  readonly server: z.infer<typeof Status>;
};
let revision = 0;
let queue: Promise<unknown> = Promise.resolve();
let registered: string | null = null;
let optedOut = false;

function serialize<T>(operation: () => Promise<T>): Promise<T> {
  const result = queue.then(operation, operation);
  queue = result;
  return result;
}

async function register(device: NativeNotificationState): Promise<void> {
  await http.put('/v1/notifications/subscription', {
    json: {
      installation_id: device.installation_id,
      subscription: { transport: 'fcm', platform: device.platform, token: device.token },
    },
  });
  registered = `${device.installation_id}:${device.token}`;
}

export function refreshNativeNotifications(): Promise<NativeNotificationSnapshot> {
  const current = revision;
  return serialize(async () => {
    const device = await nativeNotificationState();
    const server = await read(
      `/v1/notifications?installation_id=${device.installation_id}&transport=fcm`,
      Status,
    );
    if (
      current === revision &&
      !optedOut &&
      server.enabled &&
      server.configured &&
      device.configured &&
      device.permission === 'granted' &&
      device.token &&
      registered !== `${device.installation_id}:${device.token}`
    ) {
      await register(device);
    }
    if (!server.enabled) registered = null;
    return { device, server };
  });
}

export async function enableNativeNotifications(): Promise<NotificationPermission> {
  const current = ++revision;
  const device = await nativeNotificationState(true);
  return serialize(async () => {
    if (current !== revision || device.permission !== 'granted') return device.permission;
    if (!device.configured || !device.token) throw new NativeNotificationUnavailable();
    await register(device);
    optedOut = false;
    return device.permission;
  });
}

export function disableNativeNotifications(): Promise<void> {
  revision++;
  optedOut = true;
  return serialize(async () => {
    const device = await nativeNotificationState();
    await http.delete(`/v1/notifications/subscription/${device.installation_id}`);
    registered = null;
  });
}

export class NativeNotificationUnavailable extends Error {
  constructor() {
    super('기기 알림을 등록하지 못했어요. 네트워크와 알림 설정을 확인한 뒤 다시 시도해 주세요.');
  }
}
