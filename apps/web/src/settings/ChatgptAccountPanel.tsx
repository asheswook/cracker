import { useEffect, useId, useRef, useState } from 'react';
import { z } from 'zod';
import { AccountStatus, AccountAction, LoginLocation } from '../../../../packages/models/account-schema';
import { http, errorMessage } from '../api';
import { Button, ErrorNotice } from '../primitives';
import { connectLocalModelAccount, supportsLocalModelLogin, LocalLoginError } from '../native-model-login';

type Status = z.infer<typeof AccountStatus>;
const labels = { unknown: '연결 확인 중', disconnected: '연결되지 않음', connected: '연결됨', requires_login: '다시 로그인 필요', connecting: '로그인 중' };
const errors = {
  login_failed: '로그인을 완료하지 못했어요. 다시 시도해 주세요.',
  login_timeout: '로그인 시간이 만료됐어요. 다시 로그인해 주세요.',
  login_interrupted: '컴퓨터 연결이 끊겨 로그인이 중단됐어요. 다시 시도해 주세요.',
  revocation_unconfirmed: '이 컴퓨터의 연결은 해제했어요. ChatGPT의 원격 세션 폐기 여부는 확인하지 못했어요.',
  credential_error: '계정 연결을 확인하지 못했어요. 잠시 후 다시 확인하거나 다시 로그인해 주세요.',
  browser_unavailable: '컴퓨터의 로그인 창을 열지 못했어요. 다시 시도해 주세요.',
};
export function ChatgptAccountPanel({ vmId, onComputer, onChanged }: { readonly vmId: string; readonly onComputer?: (() => void) | undefined; readonly onChanged: () => Promise<void> }) {
  const [status, setStatus] = useState<Status | null>(null);
  const [error, setError] = useState('');
  const [sending, setSending] = useState(false);
  const [refresh, setRefresh] = useState(0);
  const [localAvailable, setLocalAvailable] = useState(false);
  const [location, setLocation] = useState<z.infer<typeof LoginLocation>>('vm');
  const locationId = useId();
  useEffect(() => {
    let current = true;
    void supportsLocalModelLogin().then(value => { if (current) setLocalAvailable(value); });
    return () => { current = false; };
  }, []);
  const retry = useRef<{ request_id: string; action: z.infer<typeof AccountAction> } | null>(null);
  const changed = useRef(onChanged);
  changed.current = onChanged;
  const previous = useRef<string | undefined>(undefined);
  useEffect(() => {
    const abort = new AbortController();
    let timer: ReturnType<typeof setTimeout>;
    const poll = async () => {
      let delay = 10000;
      try {
        const next = AccountStatus.parse(await http.get('/v1/model-account', { searchParams: { vm_id: vmId }, signal: abort.signal }).json());
        if (abort.signal.aborted) return;
        setStatus(next);
        const key = `${next.request_id}:${next.request_status}:${next.state}`;
        if (previous.current !== key) {
          if (next.request_status === 'completed' || next.request_status === 'failed') await changed.current();
          previous.current = key;
        }
        if (next.request_status === 'pending' || next.request_status === 'running') delay = 1500;
      } catch (failure) { if (!abort.signal.aborted) setError(errorMessage(failure)); }
      finally { if (!abort.signal.aborted) timer = setTimeout(() => void poll(), delay); }
    };
    void poll();
    return () => { abort.abort(); clearTimeout(timer); };
  }, [vmId, refresh]);
  const submit = async (action: z.infer<typeof AccountAction>) => {
    if (sending) return;
    if (action === 'connect' && location === 'local') {
      setSending(true); setError('');
      try { await connectLocalModelAccount(vmId, setStatus); }
      catch (failure) { setError(failure instanceof LocalLoginError ? failure.message : errorMessage(failure)); }
      finally { setSending(false); setRefresh(value => value + 1); }
      return;
    }
    const request = retry.current?.action === action ? retry.current : { request_id: crypto.randomUUID(), action };
    retry.current = request;
    setSending(true); setError('');
    try {
      setStatus(AccountStatus.parse(await http.post('/v1/model-account', { json: { vm_id: vmId, ...request } }).json()));
      retry.current = null;
      setRefresh(value => value + 1);
    } catch (failure) { setError(errorMessage(failure)); }
    finally { setSending(false); }
  };
  const busy = sending || status?.request_status === 'pending' || status?.request_status === 'running';
  const connecting = busy && status?.action === 'connect';
  return <section className="model-current model-account" aria-label="ChatGPT 계정 연결">
    <span>ChatGPT 계정</span>
    <strong role="status">{busy ? connecting ? '로그인 중' : '연결 변경 중' : status ? labels[status.state] : '연결 확인 중'}</strong>
    {connecting && <p className="model-field-help">{status?.login_location === 'local' ? '로그인을 시작한 컴퓨터의 브라우저에서 인증을 완료해 주세요.' : '에이전트 컴퓨터에 열린 ChatGPT 로그인 창에서 로그인을 완료해 주세요.'}</p>}
    {status?.error_code && !busy && <p className="model-field-help" role="status">{errors[status.error_code]}</p>}
    {error && <ErrorNotice>{error}</ErrorNotice>}
    {localAvailable && <label className="model-login-location" htmlFor={locationId}>
      <span>로그인 위치</span>
      <select id={locationId} value={location} disabled={busy} onChange={event => setLocation(LoginLocation.parse(event.target.value))}>
        <option value="local">이 컴퓨터</option>
        <option value="vm">에이전트 컴퓨터</option>
      </select>
    </label>}
    <div className="model-account-actions">
      {connecting && status?.login_location !== 'local' && onComputer && <Button onClick={onComputer}>컴퓨터 열기</Button>}
      {!connecting && <Button disabled={!status || busy} onClick={() => void submit('connect')}>{status?.state === 'disconnected' ? 'ChatGPT로 로그인' : '다시 로그인'}</Button>}
      {status && status.state !== 'disconnected' && <Button disabled={busy} onClick={() => void submit('disconnect')}>연결 해제</Button>}
    </div>
  </section>;
}
