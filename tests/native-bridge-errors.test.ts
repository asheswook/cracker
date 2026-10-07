import { afterEach, expect, test } from 'bun:test';
import { nativeNotificationState, nativeNotificationAttention } from '../apps/web/src/native-bridge';

const originalWindow = Object.getOwnPropertyDescriptor(globalThis, 'window');
afterEach(() => {
  if (originalWindow) Object.defineProperty(globalThis, 'window', originalWindow);
  else Reflect.deleteProperty(globalThis, 'window');
});

const cases = [
  ['unconfigured', '이 앱에 Firebase 알림 설정이 없습니다. 앱 관리자에게 설정된 빌드를 요청하세요.'],
  ['timed_out', '알림 등록 시간이 초과되었습니다. 인터넷 연결과 알림 권한을 확인한 뒤 다시 시도하세요.'],
  ['permission_failed', '알림 권한을 확인하지 못했습니다. 시스템 설정을 확인한 뒤 다시 시도하세요.'],
  ['registration_failed', 'Apple 푸시 알림 등록에 실패했습니다. 서명과 APNs 설정을 확인해야 합니다.'],
  ['token_failed', '알림 토큰을 받지 못했습니다. 네트워크와 Firebase APNs 설정을 확인한 뒤 다시 시도하세요.'],
] as const;

function install(reply: () => Promise<unknown>) {
  Object.defineProperty(globalThis, 'window', { configurable: true, value: {
    webkit: { messageHandlers: { assistantNative: { postMessage: reply } } },
  } });
}

for (const value of [true, false, null, { active: true }]) test(`attention requires a native boolean reply: ${JSON.stringify(value)}`, async () => {
  install(async () => value);
  expect(await nativeNotificationAttention('11111111-1111-4111-8111-111111111111')).toBe(value === true);
});
test('legacy native attention rejection fails open', async () => {
  install(async () => { throw new Error('Unknown native bridge method'); });
  expect(await nativeNotificationAttention('11111111-1111-4111-8111-111111111111')).toBe(false);
});
test('stalled native attention reply cannot extend a viewing lease', async () => {
  install(() => new Promise(() => {}));
  expect(await nativeNotificationAttention('11111111-1111-4111-8111-111111111111')).toBe(false);
});

for (const [code, message] of cases) {
  test(`native ${code} preserves its safe actionable message`, async () => {
    install(async () => ({ version: 1, error: { code } }));
    const error: unknown = await nativeNotificationState(true).catch((error: unknown) => error);
    expect(error).toMatchObject({ code, message });
  });
}

test('unknown native error payload does not expose raw OS details', async () => {
  install(async () => ({ version: 1, error: { code: 'os_failed', message: 'private-device-details' } }));
  const error: unknown = await nativeNotificationState(true).catch((error: unknown) => error);
  expect(error).toMatchObject({ code: 'invalid', message: '기기 알림 설정을 확인하지 못했어요. 앱을 다시 열고 시도해 주세요.' });
});

test('legacy native rejection stays generic rather than exposing its text', async () => {
  install(async () => { throw new Error('private-device-details'); });
  const error: unknown = await nativeNotificationState(true).catch((error: unknown) => error);
  expect(error).toMatchObject({ code: 'request', message: '기기 알림 설정을 확인하지 못했어요. 앱을 다시 열고 시도해 주세요.' });
});

test('version 1 native success state remains unchanged', async () => {
  const state = { version: 1, platform: 'macos', installation_id: '11111111-1111-4111-8111-111111111111', configured: true, permission: 'granted', token: 'fixture-token' } as const;
  install(async () => state);
  expect(await nativeNotificationState(true)).toEqual(state);
});
