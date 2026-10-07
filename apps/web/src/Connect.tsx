import { HTTPError } from 'ky';
import { useState } from 'react';
import { ArrowRight, ShieldCheck, Fingerprint } from 'lucide-react';
import { client } from './store';
import { errorMessage } from './api';
import { Button, Mark, ErrorNotice, Surface } from './primitives';
export function Connect() {
  const [token, setToken] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  return (
    <main className="connect-page">
      <div className="connect-brand">
        <Mark />
        <span>Assistant</span>
      </div>
      <Surface className="connect-content">
        <div className="eyebrow">조금 더 가벼운 일상</div>
        <h1>
          생각은 대화로.
          <br />
          일은 어시스턴트에게.
        </h1>
        <p className="connect-description">
          일을 맡기고, 함께 살펴보고,
          <br />
          필요한 순간 직접 이어서 하세요.
        </p>
        <form
          className="connect-form"
          onSubmit={(e) => {
            e.preventDefault();
            setBusy(true);
            setError('');
            void client
              .login(token)
              .catch((e) =>
                setError(
                  e instanceof HTTPError && [400, 401, 403].includes(e.response.status)
                    ? '연결 정보를 확인해 주세요. 올바른 클라이언트 접근 토큰이 필요해요.'
                    : errorMessage(e),
                ),
              )
              .finally(() => setBusy(false));
          }}
        >
          <label htmlFor="access-token">안전하게 연결하기</label>
          <div className="token-field">
            <Fingerprint size={20} />
            <input
              id="access-token"
              type="password"
              autoComplete="off"
              placeholder="클라이언트 접근 토큰"
              value={token}
              onChange={(e) => setToken(e.target.value)}
              required
            />
          </div>
          {error && <ErrorNotice>{error}</ErrorNotice>}
          <Button type="submit" className="primary" busy={busy} disabled={!token.trim()}>
            {busy ? '연결 중' : '나의 어시스턴트 열기'}
            <ArrowRight size={16} />
          </Button>
          <p className="security-note">
            <ShieldCheck size={14} />
            입력한 접근 키는 로그인에만 사용해요.
          </p>
        </form>
      </Surface>
      <span className="connect-footer">내 대화. 내 컴퓨터. 나의 어시스턴트.</span>
    </main>
  );
}
