import { HTTPError } from 'ky';
import { useState } from 'react';
import { client } from './store';
import { errorMessage } from './api';
import { Button, Mark, ErrorNotice, Surface } from './primitives';
export function Connect() {
  const [token, setToken] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  return (
    <main className="connect-page">
      <Surface className="connect-content">
        <Mark />
        <h1>Assistant에 로그인</h1>
        <p className="connect-description">설치할 때 받은 접근 토큰을 입력하세요.</p>
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
                    ? '토큰이 맞지 않아요. 다시 확인해 주세요.'
                    : errorMessage(e),
                ),
              )
              .finally(() => setBusy(false));
          }}
        >
          <label htmlFor="access-token" className="visually-hidden">접근 토큰</label>
          <input
            id="access-token"
            className="token-input"
            type="password"
            autoComplete="current-password"
            placeholder="접근 토큰"
            value={token}
            onChange={(e) => setToken(e.target.value)}
            required
            autoFocus
          />
          {error && <ErrorNotice>{error}</ErrorNotice>}
          <Button type="submit" className="primary" busy={busy} disabled={!token.trim()}>
            {busy ? '확인 중…' : '로그인'}
          </Button>
        </form>
      </Surface>
    </main>
  );
}
