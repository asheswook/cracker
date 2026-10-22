import { z } from 'zod';
import { parseResultLink } from './result-link';

const NotificationState = z
  .object({
    version: z.literal(1),
    platform: z.enum(['ios', 'macos']),
    installation_id: z.uuid(),
    configured: z.boolean(),
    permission: z.enum(['default', 'granted', 'denied']),
    token: z.string().min(1).max(4096).nullable(),
  })
  .readonly();
export type NativeNotificationState = z.infer<typeof NotificationState>;
const NotificationFailure = z.object({
  version: z.literal(1),
  error: z.object({ code: z.enum(['unconfigured', 'timed_out', 'permission_failed', 'registration_failed', 'token_failed']) }).strict(),
}).strict();
const errorMessages = {
  unavailable: '기기 알림 설정을 확인하지 못했어요. 앱을 다시 열고 시도해 주세요.',
  invalid: '기기 알림 설정을 확인하지 못했어요. 앱을 다시 열고 시도해 주세요.',
  request: '기기 알림 설정을 확인하지 못했어요. 앱을 다시 열고 시도해 주세요.',
  timeout: '기기 응답이 늦어지고 있어요. 네트워크와 알림 설정을 확인한 뒤 다시 시도해 주세요.',
  unconfigured: '이 앱에 Firebase 알림 설정이 없습니다. 앱 관리자에게 설정된 빌드를 요청하세요.',
  timed_out: '알림 등록 시간이 초과되었습니다. 인터넷 연결과 알림 권한을 확인한 뒤 다시 시도하세요.',
  permission_failed: '알림 권한을 확인하지 못했습니다. 시스템 설정을 확인한 뒤 다시 시도하세요.',
  registration_failed: 'Apple 푸시 알림 등록에 실패했습니다. 서명과 APNs 설정을 확인해야 합니다.',
  token_failed: '알림 토큰을 받지 못했습니다. 네트워크와 Firebase APNs 설정을 확인한 뒤 다시 시도하세요.',
} as const;
export type NativeComposerMessage =
  | { readonly method: 'panelTransition'; readonly version: 2 | 3 | 4; readonly source?: 'menu' | undefined; readonly kind: 'begin' | 'source' | 'finish' | 'cancel'; readonly document: string; readonly generation: number; readonly target: 'panel' | 'chat' | 'menu'; readonly reader?: import('./native-reader-protocol').ReaderSnapshotValue | undefined }
  | { readonly method: 'composerConnect'; readonly version: 1; readonly document: string }
  | { readonly method: 'composerState'; readonly state: import('./native-composer').NativeComposerState }
  | { readonly method: 'composerHide'; readonly document: string; readonly session: string };
type Method = 'getNotificationState' | 'requestNotifications' | 'openNotificationSettings' | 'ready';
const ShellConfiguration = z.object({ version: z.literal(1), role: z.enum(['body', 'panel']), panel: z.enum(['computer', 'settings', 'tasks', 'schedules', 'memory']).optional() });
const ShellCommand = z.object({ version: z.literal(1), conversation: z.uuid(), message: z.uuid().optional() }).strict();
export function nativeShellConfiguration() {
  return ShellConfiguration.safeParse(window.__ASSISTANT_SHELL__).data;
}
export function listenNativeShell(select: (conversation: string, message?: string) => Promise<boolean>) {
  if (!nativeShellConfiguration()) return () => {};
  const handler = async (value: unknown) => {
    const command = ShellCommand.safeParse(value);
    if (!command.success) return { version: 1, accepted: false };
    try { return { version: 1, accepted: await select(command.data.conversation, command.data.message) }; }
    catch { return { version: 1, accepted: false }; }
  };
  window.__assistantShellCommand = handler;
  return () => { if (window.__assistantShellCommand === handler) delete window.__assistantShellCommand; };
}
export async function openInNativeBody(conversation: string, message: string) {
  const reply = await window.webkit?.messageHandlers?.assistantNative?.postMessage({ method: 'shellOpen', version: 1, conversation, message });
  if (!z.object({ accepted: z.literal(true) }).safeParse(reply).success) throw new Error('대화를 열지 못했어요. 다시 시도해 주세요.');
}
export function requestNativePanel(panel: string) {
  void window.webkit?.messageHandlers?.assistantNative?.postMessage({ method: 'shellPanel', version: 1, panel }).catch(() => {});
}
export function publishNativeShell(authenticated: boolean, conversation: string | null, assistant: string | null, name: string, booting = false) {
  if (!nativeShellConfiguration()) return;
  void window.webkit?.messageHandlers?.assistantNative?.postMessage({ method: 'shellState', version: 1, authenticated, conversation, assistant, name, booting }).catch(() => {});
}
export function hasNativeCredentialBridge(): boolean {
  return typeof window !== 'undefined' && Boolean(nativeShellConfiguration());
}
export async function saveNativeCredential(token: string): Promise<void> {
  if (!hasNativeCredentialBridge()) return;
  await window.webkit?.messageHandlers?.assistantNative?.postMessage({ method: 'credentialSave', version: 1, token }).catch(() => undefined);
}
export async function loadNativeCredential(): Promise<string | null> {
  if (!hasNativeCredentialBridge()) return null;
  const reply = await window.webkit?.messageHandlers?.assistantNative?.postMessage({ method: 'credentialLoad', version: 1 }).catch(() => undefined);
  const token = (reply as { token?: unknown } | undefined)?.token;
  return typeof token === 'string' && token.length >= 32 ? token : null;
}
export async function clearNativeCredential(): Promise<void> {
  if (!hasNativeCredentialBridge()) return;
  await window.webkit?.messageHandlers?.assistantNative?.postMessage({ method: 'credentialClear', version: 1 }).catch(() => undefined);
}
declare global {
  interface Window {
    readonly __ASSISTANT_SHELL__?: unknown;
    __assistantShellCommand?: (value: unknown) => Promise<{ version: number; accepted: boolean }>;
    readonly webkit?: {
      readonly messageHandlers?: {
        readonly assistantFooter?: { postMessage(message: object): Promise<unknown> };
        readonly assistantReader?: { postMessage(message: import('./native-reader-protocol').ReaderPacket): Promise<unknown> };
        readonly assistantHeader?: { postMessage(message: object): Promise<unknown> };
        readonly assistantNative?: { postMessage(message: { readonly method: 'shellPanel'; readonly version: 1; readonly panel: string } | { readonly method: 'shellOpen'; readonly version: 1; readonly conversation: string; readonly message: string } | { readonly method: 'shellState'; readonly version: 1; readonly authenticated: boolean; readonly conversation: string | null; readonly assistant: string | null; readonly name: string; readonly booting: boolean } | { readonly method: Method } | { readonly method: 'getNotificationAttention'; readonly conversation_id: string | null } | NativeComposerMessage | import('./native-model-login').ModelLoginMessage | { readonly method: 'hybridConnect'; readonly version: 1; readonly document: string } | { readonly method: 'credentialSave'; readonly version: 1; readonly token: string } | { readonly method: 'credentialLoad' | 'credentialClear'; readonly version: 1 }): Promise<unknown> };
      };
    };
  }
}

export class NativeBridgeError extends Error {
  constructor(readonly code: keyof typeof errorMessages) {
    super(errorMessages[code]);
  }
}

export function isNativeApp(): boolean {
  return typeof window.webkit?.messageHandlers?.assistantNative?.postMessage === 'function';
}

export async function nativeNotificationAttention(conversation: string | null): Promise<boolean> {
  const bridge = window.webkit?.messageHandlers?.assistantNative;
  if (!bridge) return false;
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    const value = await Promise.race([
      bridge.postMessage({ method: 'getNotificationAttention', conversation_id: conversation }),
      new Promise<false>(resolve => { timer = setTimeout(() => resolve(false), 900); }),
    ]);
    return z.boolean().safeParse(value).data === true;
  } catch (error) {
    if (error instanceof Error) return false;
    throw error;
  } finally { clearTimeout(timer); }
}

async function call(method: Method): Promise<unknown> {
  const bridge = window.webkit?.messageHandlers?.assistantNative;
  if (!bridge) throw new NativeBridgeError('unavailable');
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      bridge.postMessage({ method }),
      new Promise<never>((_, reject) => {
        timer = setTimeout(
          () => reject(new NativeBridgeError('timeout')),
          method === 'requestNotifications' ? 60_000 : 30_000,
        );
      }),
    ]);
  } catch (error) {
    if (error instanceof NativeBridgeError) throw error;
    // Native error payloads may contain device details; expose only a fixed message.
    throw new NativeBridgeError('request');
  } finally {
    clearTimeout(timer);
  }
}

export async function nativeNotificationState(request = false): Promise<NativeNotificationState> {
  const reply = await call(request ? 'requestNotifications' : 'getNotificationState');
  const failure = NotificationFailure.safeParse(reply);
  if (failure.success) throw new NativeBridgeError(failure.data.error.code);
  const result = NotificationState.safeParse(reply);
  if (!result.success) throw new NativeBridgeError('invalid');
  return result.data;
}

export async function openNativeNotificationSettings(): Promise<void> {
  if (!z.null().safeParse(await call('openNotificationSettings')).success)
    throw new NativeBridgeError('invalid');
}

export function listenNativeResults(
  receive: (href: string) => void,
  fail: (error: unknown) => void,
): () => void {
  if (!isNativeApp()) return () => {};
  const listen = (event: Event) => {
    if (!(event instanceof CustomEvent)) return;
    const value = z.object({ url: z.string() }).safeParse(event.detail);
    if (!value.success) return;
    let url: URL;
    try {
      url = new URL(value.data.url, window.location.origin);
    } catch (error) {
      if (error instanceof TypeError) return;
      throw error;
    }
    if (url.origin !== window.location.origin || url.pathname !== '/' || url.username || url.password) return;
    if ([...url.searchParams.keys()].some((key) => key !== 'conversation' && key !== 'message')) return;
    if (parseResultLink(url).kind === 'result') receive(url.href);
  };
  window.addEventListener('assistant-native-result', listen);
  void call('ready')
    .then((result) => {
      if (result !== null) throw new NativeBridgeError('invalid');
    })
    .catch(fail);
  return () => window.removeEventListener('assistant-native-result', listen);
}
