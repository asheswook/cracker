import { z } from 'zod';
import { AccountStatus, LocalCallback, LocalRedirect } from '../../../packages/models/account-schema';
import { http } from './api';
import { isNativeApp } from './native-bridge';

export type ModelLoginMessage =
  | { readonly method: 'modelLoginCapabilities' | 'modelLoginPrepare' }
  | { readonly method: 'modelLoginAuthorize'; readonly session_id: string; readonly authorization_url: string }
  | { readonly method: 'modelLoginCancel'; readonly session_id: string };
export class LocalLoginError extends Error {
  constructor(readonly code: 'unsupported' | 'timeout' | 'failed') {
    super({ unsupported: '이 앱은 로컬 로그인을 지원하지 않아요. 최신 Mac 앱을 사용해 주세요.', timeout: '로그인 시간이 만료됐어요. 다시 시도해 주세요.', failed: '로컬 로그인을 완료하지 못했어요. 다시 시도해 주세요.' }[code]);
  }
}
async function native(message: ModelLoginMessage, timeout = 5000): Promise<unknown> {
  const bridge = window.webkit?.messageHandlers?.assistantNative;
  if (!bridge) throw new LocalLoginError('unsupported');
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([bridge.postMessage(message), new Promise<never>((_, reject) => {
      timer = setTimeout(() => reject(new LocalLoginError('timeout')), timeout);
    })]);
  } catch (error) {
    if (error instanceof LocalLoginError) throw error;
    throw new LocalLoginError('failed');
  } finally { clearTimeout(timer); }
}
export async function supportsLocalModelLogin(): Promise<boolean> {
  if (!isNativeApp()) return false;
  try {
    return z.object({ version: z.literal(1), platform: z.literal('macos'), local: z.literal(true) }).safeParse(await native({ method: 'modelLoginCapabilities' }, 1000)).success;
  } catch (error) { if (error instanceof LocalLoginError) return false; throw error; }
}
export async function connectLocalModelAccount(vmId: string, receive: (status: z.infer<typeof AccountStatus>) => void): Promise<void> {
  const prepared = z.object({ version: z.literal(1), session_id: z.uuid(), redirect_uri: LocalRedirect }).parse(await native({ method: 'modelLoginPrepare' }));
  const request = { vm_id: vmId, request_id: prepared.session_id };
  try {
    receive(AccountStatus.parse(await http.post('/v1/model-account', { json: { ...request, action: 'connect', login_location: 'local', redirect_uri: prepared.redirect_uri } }).json()));
    const deadline = performance.now() + 60000;
    let authorization: string | null = null;
    while (!authorization && performance.now() < deadline) {
      const result = z.object({ authorization_url: z.url().nullable() }).parse(await http.get('/v1/model-account/authorization', { searchParams: request }).json());
      authorization = result.authorization_url;
      if (!authorization) await new Promise(resolve => setTimeout(resolve, 1000));
    }
    if (!authorization) throw new LocalLoginError('timeout');
    const result = z.object({ version: z.literal(1), session_id: z.literal(prepared.session_id), callback: LocalCallback }).parse(await native({ method: 'modelLoginAuthorize', session_id: prepared.session_id, authorization_url: authorization }, 303000));
    await http.post('/v1/model-account/callback', { json: { ...request, callback: result.callback }, retry: { limit: 2, methods: ['post'], statusCodes: [502, 503, 504] } });
  } catch (error) {
    await http.post('/v1/model-account/cancel-local', { json: request, timeout: 3000 }).catch(failure => { if (!(failure instanceof Error)) throw failure; });
    throw error;
  } finally {
    await native({ method: 'modelLoginCancel', session_id: prepared.session_id }, 1000).catch(error => { if (!(error instanceof LocalLoginError)) throw error; });
  }
}
