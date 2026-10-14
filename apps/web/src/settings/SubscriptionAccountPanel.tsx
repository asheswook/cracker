import { useCallback, useEffect, useId, useRef, useState } from 'react';
import { RefreshCw } from 'lucide-react';
import { z } from 'zod';
import { SubscriptionAccount, SubscriptionCallback, SubscriptionModel, SubscriptionProvider } from '../../../../packages/models/subscription-schema';
import { subscriptionDelay, subscriptionRequest } from '../subscription';
import { Button, ErrorNotice } from '../primitives';
import { errorMessage } from '../api';

export function SubscriptionAccountPanel({ vmId, onModels, onChanged, onComputer }: {
  readonly vmId: string;
  readonly onModels: (models: z.infer<typeof SubscriptionModel>[]) => void;
  readonly onChanged: () => Promise<void>;
  readonly onComputer?: (() => void) | undefined;
}) {
  const id = useId();
  const [accounts, setAccounts] = useState<z.infer<typeof SubscriptionAccount>[]>([]);
  const [loading, setLoading] = useState(false);
  const [busy, setBusy] = useState(false);
  const [sending, setSending] = useState(false);
  const [error, setError] = useState('');
  const [notice, setNotice] = useState('');
  const [location, setLocation] = useState<'vm' | 'local'>('vm');
  const [login, setLogin] = useState<{ url: string; state: string } | null>(null);
  const [callback, setCallback] = useState('');
  const lifecycle = useRef(new AbortController());
  const changed = useRef(onChanged), models = useRef(onModels);
  changed.current = onChanged; models.current = onModels;
  const refresh = useCallback(async () => {
    const signal = lifecycle.current.signal;
    setLoading(true); setError('');
    try {
      const result = await subscriptionRequest(vmId, { action: 'catalogue' }, signal);
      if (signal.aborted || result.action !== 'catalogue') return;
      setAccounts(result.accounts); models.current(result.models);
      await changed.current();
    } catch (failure) { if (!signal.aborted) setError(errorMessage(failure)); }
    finally { if (!signal.aborted) setLoading(false); }
  }, [vmId]);
  useEffect(() => {
    lifecycle.current = new AbortController();
    void refresh();
    return () => lifecycle.current.abort();
  }, [refresh]);
  const connect = async (provider: z.infer<typeof SubscriptionProvider>) => {
    const signal = lifecycle.current.signal;
    setBusy(true); setError(''); setNotice(''); setCallback('');
    try {
      const result = await subscriptionRequest(vmId, { action: 'login', provider, location }, signal);
      if (result.action !== 'login') return;
      setLogin(result);
      const deadline = Date.now() + 7 * 60000;
      while (Date.now() < deadline) {
        await subscriptionDelay(signal);
        const status = await subscriptionRequest(vmId, { action: 'status', state: result.state }, signal);
        if (status.action !== 'status') throw new Error('로그인 상태를 확인하지 못했어요.');
        if (status.status === 'error') throw new Error('로그인에 실패했어요. 다시 시도해 주세요.');
        if (status.status === 'ok') { setNotice('계정을 연결했어요.'); await refresh(); return; }
      }
      throw new Error('로그인 시간이 만료됐어요. 다시 시도해 주세요.');
    } catch (failure) { if (!signal.aborted) setError(errorMessage(failure)); }
    finally { if (!signal.aborted) { setBusy(false); setLogin(null); setCallback(''); } }
  };
  const submit = async () => {
    if (!login) return;
    const parsed = SubscriptionCallback.safeParse(callback.trim());
    if (!parsed.success || new URL(parsed.data).searchParams.get('state') !== login.state) {
      setError('이번 로그인에서 마지막으로 열린 localhost 주소를 붙여 넣어 주세요.'); return;
    }
    const signal = lifecycle.current.signal;
    setSending(true); setError('');
    try {
      await subscriptionRequest(vmId, { action: 'callback', state: login.state, redirect_url: parsed.data }, signal);
      if (!signal.aborted) { setCallback(''); setNotice('인증을 확인하고 있어요.'); }
    } catch (failure) { if (!signal.aborted) setError(errorMessage(failure)); }
    finally { if (!signal.aborted) setSending(false); }
  };
  return <section className="model-current model-account" aria-label="구독 계정 연결" aria-busy={loading}>
    <strong>구독 계정</strong>
    {loading ? <p role="status">계정과 모델을 불러오는 중이에요.</p> : accounts.length ?
      <ul>{accounts.map((account, index) => <li key={`${account.provider}-${index}`}>{account.provider} · {account.label || '이름 없음'} · {account.status}</li>)}</ul> :
      <p className="model-field-help">연결된 구독 계정이 없어요.</p>}
    {error && <ErrorNotice>{error}</ErrorNotice>}
    {notice && <p role="status">{notice}</p>}
    <label htmlFor={`${id}-location`}>로그인 위치</label>
    <select id={`${id}-location`} value={location} disabled={busy} onChange={event => setLocation(z.enum(['vm', 'local']).parse(event.target.value))}>
      <option value="vm">에이전트 컴퓨터</option><option value="local">이 기기</option>
    </select>
    <div className="model-account-actions">
      <Button disabled={busy || loading} onClick={() => void connect('claude')}>Claude 연결</Button>
      <Button disabled={busy || loading} onClick={() => void connect('codex')}>ChatGPT(Codex) 연결</Button>
      <Button disabled={busy || loading} onClick={() => void refresh()}><RefreshCw size={14} />목록 새로고침</Button>
    </div>
    {busy && <p role="status">로그인을 기다리고 있어요.</p>}
    {login && location === 'vm' && <>
      <p className="model-field-help">에이전트 컴퓨터의 브라우저에서 로그인해 주세요.</p>
      {onComputer && <Button onClick={onComputer}>컴퓨터 열기</Button>}
    </>}
    {login && location === 'local' && <>
      <a href={login.url} target="_blank" rel="noreferrer">로그인 페이지 열기</a>
      <label htmlFor={`${id}-auth`}>로그인 주소</label>
      <input id={`${id}-auth`} readOnly value={login.url} />
      <p className="model-field-help">로그인 뒤 localhost 페이지가 열리지 않아도 괜찮아요. 마지막 주소 전체를 아래에 붙여 넣어 주세요.</p>
      <label htmlFor={`${id}-callback`}>마지막 localhost 주소</label>
      <input id={`${id}-callback`} value={callback} autoComplete="off" spellCheck={false} onChange={event => setCallback(event.target.value)} />
      <Button disabled={sending || !callback.trim()} busy={sending} onClick={() => void submit()}>인증 완료</Button>
    </>}
  </section>;
}
