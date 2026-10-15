import { useState } from 'react';
import { http, errorMessage } from '../api';
import { Button, ErrorNotice } from '../primitives';
import type { Id } from '../types';
import { McpConfig, Server } from './types';
import type { SecretField, SecretMode } from './types';
import { EditDialog } from './EditDialog';
import { SecretFields } from './SecretFields';
function configuration(transport: 'stdio' | 'http', command: string, args: string, url: string): McpConfig {
  if (transport === 'stdio') {
    let parsed: unknown;
    try {
      parsed = JSON.parse(args);
    } catch {
      throw new Error('인수는 JSON 문자열 배열로 입력해 주세요.');
    }
    const result = McpConfig.safeParse({ transport, command: command.trim(), args: parsed });
    if (!result.success || command.trim().length === 0)
      throw new Error('실행 명령과 인수 배열을 확인해 주세요.');
    return result.data;
  }
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    throw new Error('올바른 서버 주소를 입력해 주세요.');
  }
  if (
    parsed.protocol !== 'https:' &&
    !(parsed.protocol === 'http:' && ['localhost', '127.0.0.1', '[::1]'].includes(parsed.hostname))
  )
    throw new Error('HTTPS 주소 또는 선택한 컴퓨터의 localhost HTTP 주소를 사용해 주세요.');
  return { transport, url: url.trim() };
}
export function ServerEditor({
  vm,
  item,
  onClose,
  onSaved,
}: {
  vm: Id;
  item: Server | null;
  onClose: () => void;
  onSaved: () => void;
}) {
  const [name, setName] = useState(item?.name ?? '');
  const [enabled, setEnabled] = useState(item?.enabled ?? true);
  const [category, setCategory] = useState<Server['category']>(item?.category ?? null);
  const [transport, setTransport] = useState<'stdio' | 'http'>(item?.config.transport ?? 'http');
  const [command, setCommand] = useState(item?.config.transport === 'stdio' ? item.config.command : '');
  const [args, setArgs] = useState(
    item?.config.transport === 'stdio' ? JSON.stringify(item.config.args, null, 2) : '[]',
  );
  const [url, setUrl] = useState(item?.config.transport === 'http' ? item.config.url : '');
  const [mode, setMode] = useState<SecretMode>('keep');
  const [fields, setFields] = useState<SecretField[]>(
    () => item?.secret_keys.map((key) => ({ id: crypto.randomUUID(), key, value: '' })) ?? [],
  );
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const save = async () => {
    setError('');
    let config: McpConfig;
    let secrets: Record<string, string> | undefined;
    try {
      config = configuration(transport, command, args, url);
      if (item && transport !== item.config.transport && item.secret_keys.length && mode === 'keep')
        throw new Error('연결 방식을 바꾸려면 비밀값도 교체하거나 삭제해 주세요.');
      if (mode === 'clear') secrets = {};
      if (mode === 'replace') {
        const keys = fields.map((field) => (transport === 'http' ? field.key.toLowerCase() : field.key));
        if (new Set(keys).size !== keys.length) throw new Error('같은 키를 두 번 입력할 수 없어요.');
        if (fields.some((field) => /[\r\n\0]/.test(field.value)))
          throw new Error('비밀값에는 줄바꿈을 넣을 수 없어요.');
        secrets = Object.fromEntries(fields.map((field) => [field.key, field.value]));
      }
    } catch (failure) {
      setError(failure instanceof Error ? failure.message : '입력값을 확인해 주세요.');
      return;
    }
    setBusy(true);
    try {
      Server.parse(
        (
          await http
            .post('/v1/extensions/servers', {
              json: {
                ...(item ? { id: item.id } : {}),
                vm_id: vm,
                name,
                enabled,
                category,
                config,
                ...(secrets === undefined ? {} : { secrets }),
              },
            })
            .json<{ server: unknown }>()
        ).server,
      );
      setFields([]);
      await onSaved();
    } catch (failure) {
      setError(errorMessage(failure));
    } finally {
      setBusy(false);
    }
  };
  return (
    <EditDialog title={item ? 'MCP 서버 편집' : 'MCP 서버 추가'} busy={busy} onClose={onClose}>
      <form
        aria-busy={busy}
        className="settings-form"
        onSubmit={(event) => {
          event.preventDefault();
          void save();
        }}
      >
        <fieldset disabled={busy} className="settings-form-body">
          <p className="form-intro">
            선택한 컴퓨터에서 도구를 연결해요. 경로와 localhost 주소도 그 컴퓨터 기준이에요.
          </p>
          <label>
            서버 이름
            <input
              autoFocus
              required
              maxLength={64}
              value={name}
              onChange={(e) => setName(e.target.value)}
              placeholder="예: 작업 폴더"
            />
          </label>
          <label>
            연결 방식
            <select
              value={transport}
              onChange={(e) => setTransport(e.target.value === 'stdio' ? 'stdio' : 'http')}
            >
              <option value="http">HTTP · 서버 주소</option>
              <option value="stdio">stdio · 실행 명령</option>
            </select>
          </label>
          <label>
            도구 종류
            <select
              value={category ?? ''}
              onChange={(e) => setCategory(Server.shape.category.parse(e.target.value || null))}
            >
              <option value="">자동</option>
              <option value="web">웹 검색·브라우징</option>
              <option value="computer">컴퓨터 조작</option>
              <option value="code">코드·파일</option>
              <option value="memory">기억·자료 조회</option>
              <option value="other">기타</option>
            </select>
            <span className="field-help">어시스턴트가 이 도구를 쓸 때 대화창에 표시할 활동이에요.</span>
          </label>
          {transport === 'http' ? (
            <label>
              서버 주소
              <input
                type="url"
                required
                maxLength={2000}
                value={url}
                onChange={(e) => setUrl(e.target.value)}
                placeholder="https://example.com/mcp"
              />
              <span className="field-help">쿼리와 인증 정보가 포함된 URL도 사용할 수 있어요.</span>
            </label>
          ) : (
            <>
              <label>
                실행 명령
                <input
                  className="code-field"
                  required
                  maxLength={1000}
                  value={command}
                  onChange={(e) => setCommand(e.target.value)}
                  placeholder="예: /usr/bin/node"
                />
              </label>
              <label>
                인수 · JSON 배열
                <textarea
                  className="code-field"
                  required
                  rows={4}
                  value={args}
                  onChange={(e) => setArgs(e.target.value)}
                  spellCheck={false}
                />
                <span className="field-help">
                  예: ["/home/ubuntu/mcp-server.js"] · 비밀번호와 키는 아래 환경변수에 넣으세요.
                </span>
              </label>
            </>
          )}
          <SecretFields
            mode={mode}
            onMode={setMode}
            fields={fields}
            onFields={setFields}
            savedKeys={item?.secret_keys ?? []}
            transport={transport}
          />
          <label className="check-label">
            <input type="checkbox" checked={enabled} onChange={(e) => setEnabled(e.target.checked)} />이 서버
            사용하기
          </label>
          {error && <ErrorNotice>{error}</ErrorNotice>}
        </fieldset>
        <footer>
          <Button type="button" disabled={busy} onClick={onClose}>
            취소
          </Button>
          <Button type="submit" className="primary" busy={busy}>
            저장
          </Button>
        </footer>
      </form>
    </EditDialog>
  );
}
