import { useCallback, useEffect, useRef, useState } from 'react';
import { z } from 'zod';
import { read, http, errorMessage } from '../api';
import { Button, ErrorNotice } from '../primitives';
import { useClient } from '../store';
import { Id } from '../types';
import { ScheduleForm } from '../ScheduleForm';
import { EditDialog } from './EditDialog';
import type { Skill } from './types';
import { VersionPage, ExecutionPage, TestStarted, resultUrl } from './workflow-types';
import type { SkillVersion, SkillExecution } from './workflow-types';
import { SkillExecutionEntry } from './SkillExecutionEntry';
import './workflow.css';
const activeStates = new Set(['queued', 'running', 'waiting', 'pausing', 'paused', 'cancelling']);

export function SkillWorkflow({ skill, onClose }: { skill: Skill; onClose: () => void }) {
  const state = useClient();
  const [versions, setVersions] = useState<SkillVersion[]>([]),
    [nextVersion, setNextVersion] = useState<number | null>(null),
    [revision, setRevision] = useState(skill.revision);
  const [executions, setExecutions] = useState<SkillExecution[]>([]),
    [nextExecution, setNextExecution] = useState<string | null>(null);
  const [loading, setLoading] = useState(true),
    [busy, setBusy] = useState(false),
    [error, setError] = useState(''),
    [notice, setNotice] = useState('');
  const [reload, setReload] = useState(0);
  const executionRequest = useRef(0), pollPage = useRef(0);
  const [historyError, setHistoryError] = useState('');
  const [input, setInput] = useState(''),
    [started, setStarted] = useState<z.infer<typeof TestStarted> | null>(null),
    [scheduling, setScheduling] = useState(false);
  const attempt = useRef<{ body: string; id: string } | null>(null),
    alive = useRef(true);
  const [source, setSource] = useState<{
      conversation_id: string;
      message: { id: string; content: string };
    } | null>(null),
    [sourceError, setSourceError] = useState('');
  const version = versions.find((item) => item.revision === revision);
  const loadExecutions = useCallback(async (before?: string, preserve = false) => {
    const request = ++executionRequest.current;
    const page = await read(
      `/v1/extensions/skills/${skill.id}/executions${before ? `?before=${before}` : ''}`,
      ExecutionPage,
    );
    if (alive.current && executionRequest.current === request) {
      setExecutions(previous => {
        if (!before && !preserve) return page.executions;
        const incoming = new Map(page.executions.map(item => [item.id, item]));
        const known = new Set(previous.map(item => item.id));
        return before
          ? [...previous.map(item => incoming.get(item.id) ?? item), ...page.executions.filter(item => !known.has(item.id))]
          : [...page.executions, ...previous.filter(item => !incoming.has(item.id))];
      });
      if (!preserve) setNextExecution(page.next_cursor);
      setHistoryError('');
    }
  }, [skill.id]);
  useEffect(() => {
    if (loading || busy) return;
    const pages = [...new Set([0, ...executions.flatMap((item, index) => activeStates.has(item.task.state) ? [Math.floor(index / 50)] : [])])];
    let cancelled = false, polling = false;
    let timer: ReturnType<typeof setTimeout> | undefined;
    const poll = async () => {
      if (cancelled || polling || document.visibilityState !== 'visible') return;
      polling = true;
      const page = pages[pollPage.current++ % pages.length] ?? 0;
      try { await loadExecutions(page ? executions[page * 50 - 1]?.id : undefined, true); }
      catch (failure) { if (!cancelled) setHistoryError(`실행 기록을 새로 고치지 못했어요. ${errorMessage(failure)}`); }
      finally { polling = false; if (!cancelled && document.visibilityState === 'visible') timer = setTimeout(() => void poll(), 3000); }
    };
    const visibility = () => { clearTimeout(timer); if (document.visibilityState === 'visible') void poll(); };
    if (document.visibilityState === 'visible') timer = setTimeout(() => void poll(), 3000);
    document.addEventListener('visibilitychange', visibility);
    return () => { cancelled = true; clearTimeout(timer); document.removeEventListener('visibilitychange', visibility); };
  }, [executions, loading, busy, loadExecutions]);
  useEffect(() => {
    alive.current = true;
    let current = true;
    const abort = new AbortController();
    setLoading(true);
    setError('');
    void Promise.all([
      http
        .get(`/v1/extensions/skills/${skill.id}/versions`, { signal: abort.signal })
        .json()
        .then(VersionPage.parse),
      http
        .get(`/v1/extensions/skills/${skill.id}/executions`, { signal: abort.signal })
        .json()
        .then(ExecutionPage.parse),
    ])
      .then(([v, e]) => {
        if (current) {
          setVersions(v.versions);
          setRevision(current => v.versions.some(version => version.revision === current) ? current : (v.versions[0]?.revision ?? current));
          setNextVersion(v.next_revision);
          setExecutions(e.executions);
          setNextExecution(e.next_cursor);
        }
      })
      .catch((failure) => {
        if (!abort.signal.aborted) setError(errorMessage(failure));
      })
      .finally(() => {
        if (current) setLoading(false);
      });
    return () => {
      current = false;
      alive.current = false;
      executionRequest.current++;
      abort.abort();
    };
  }, [skill.id, reload]);
  useEffect(() => {
    setSource(null);
    setSourceError('');
    if (!version?.origin_message_id) return;
    const abort = new AbortController();
    const schema = z.object({ conversation_id: Id, message: z.object({ id: Id, content: z.string() }) });
    void http
      .get(`/v1/sources/${version.origin_message_id}`, { signal: abort.signal })
      .json()
      .then(schema.parse)
      .then((value) => {
        if (!abort.signal.aborted) setSource(value);
      })
      .catch((failure) => {
        if (!abort.signal.aborted) setSourceError(errorMessage(failure));
      });
    return () => abort.abort();
  }, [version?.origin_message_id]);
  const run = async () => {
    const body = { revision, input: input.trim() },
      serialized = JSON.stringify(body);
    if (attempt.current?.body !== serialized) attempt.current = { body: serialized, id: crypto.randomUUID() };
    setBusy(true);
    setError('');
    try {
      const result = TestStarted.parse(
        await http
          .post(`/v1/extensions/skills/${skill.id}/tests`, {
            json: { ...body, client_execution_id: attempt.current.id },
          })
          .json(),
      );
      setStarted(result);
      await loadExecutions();
    } catch (failure) {
      setError(errorMessage(failure));
    } finally {
      setBusy(false);
    }
  };
  const moreVersions = async () => {
    if (nextVersion === null) return;
    setBusy(true);
    try {
      const page = await read(
        `/v1/extensions/skills/${skill.id}/versions?before=${nextVersion}`,
        VersionPage,
      );
      setVersions((previous) => [...previous, ...page.versions]);
      setNextVersion(page.next_revision);
    } catch (failure) {
      setError(errorMessage(failure));
    } finally {
      setBusy(false);
    }
  };
  return (
    <EditDialog title={`${skill.name} · 버전·실행`} busy={busy} onClose={onClose}>
      <div className="settings-form skill-workflow">
        <div className="settings-form-body">
          {skill.archived_at && (
            <p className="field-help">
              보관된 스킬이에요. 일반 사용은 꺼져 있고, 보존된 특정 버전을 명시적으로 실행할 수 있어요.
            </p>
          )}
          {loading ? (
            <p role="status">버전과 실행 기록을 불러오는 중이에요.</p>
          ) : (
            <>
              <label>
                저장된 버전
                <select
                  value={revision}
                  onChange={(e) => {
                    setRevision(Number(e.target.value));
                    setStarted(null);
                    setScheduling(false);
                  }}
                  disabled={busy}
                >
                  {versions.map((v) => (
                    <option key={v.revision} value={v.revision}>
                      버전 {v.revision} · {new Date(v.created_at).toLocaleString('ko-KR')}
                    </option>
                  ))}
                </select>
              </label>
              {nextVersion !== null && (
                <Button disabled={busy} onClick={() => void moreVersions()}>
                  이전 버전 더 보기
                </Button>
              )}
              {version && (
                <>
                  <p><strong>{version.name}</strong> · {version.description}</p>
                  <details>
                    <summary>버전 {revision} 저장된 문서</summary>
                    <pre className="workflow-document">{version.content}</pre>
                    <small>문서 해시 {version.content_hash}</small>
                  </details>
                  {source ? (
                    <details>
                      <summary>작성 근거 원문</summary>
                      <p className="workflow-source">{source.message.content}</p>
                      <a href={resultUrl(source.conversation_id, source.message.id)} target="_blank" rel="noopener" title="새 탭에서 열기">정확한 메시지 보기</a>
                    </details>
                  ) : version.origin_message_id ? (
                    <p>{sourceError || '작성 근거를 불러오는 중이에요.'}</p>
                  ) : (
                    <p className="field-help">연결된 작성 근거 원문이 없어요.</p>
                  )}
                </>
              )}
              <section>
                <h3>다른 입력으로 실행</h3>
                <p className="field-help">
                  선택한 버전 {revision}을 전용 대화에서 실행해요. 실제 컴퓨터와 연결된 도구에서 동작하며
                  시뮬레이션이 아니에요. 현재는 텍스트 입력만 지원해요. 꺼진 초안도 이 실행에서만 사용할 수
                  있어요.
                </p>
                {started ? (
                  <div role="status">
                    <p>실행을 만들었어요. 결과는 전용 대화에 도착해요.</p>
                    <a href={`/?conversation=${started.conversation_id}`} target="_blank" rel="noopener" title="새 탭에서 열기">실행 대화 보기</a>
                    <Button
                      onClick={() => {
                        setStarted(null);
                        setInput('');
                        attempt.current = null;
                      }}
                    >
                      새 입력으로 실행 준비
                    </Button>
                  </div>
                ) : (
                  <form
                    onSubmit={(e) => {
                      e.preventDefault();
                      void run();
                    }}
                  >
                    <label>
                      새 입력
                      <textarea
                        required
                        maxLength={100000}
                        rows={4}
                        value={input}
                        onChange={(e) => setInput(e.target.value)}
                        disabled={busy}
                      />
                    </label>
                    <Button
                      type="submit"
                      className="primary"
                      busy={busy}
                      disabled={!version || !input.trim()}
                    >
                      버전 {revision} 실행
                    </Button>
                  </form>
                )}
              </section>
              <section>
                <h3>이 버전으로 예약</h3>
                {scheduling ? (
                  <ScheduleForm
                    key={`${skill.id}:${revision}`}
                    state={state}
                    skill={{ id: skill.id, revision, name: skill.name }}
                    onDone={() => {
                      setScheduling(false);
                      setNotice(`버전 ${revision}에 고정된 예약을 저장했어요.`);
                    }}
                  />
                ) : (
                  <Button disabled={!version} onClick={() => setScheduling(true)}>
                    버전 {revision} 한 번 예약
                  </Button>
                )}
              </section>
            <section>
              <div className="workflow-section-heading">
                  <h3>실행 기록</h3>
                  <Button
                    disabled={busy}
                    onClick={() => {
                      setError('');
                      void loadExecutions().catch((failure) => setError(errorMessage(failure)));
                    }}
                  >
                    기록 새로고침
                  </Button>
              </div>
              {historyError && <ErrorNotice>{historyError}</ErrorNotice>}
                <p className="field-help">
                  실행 상태, 실제로 읽은 버전, 사용자의 결과 점검은 서로 다른 기록이에요.
                </p>
                {executions.length === 0 ? (
                  <p>아직 실행 기록이 없어요.</p>
                ) : (
                  executions.map((execution) => (
                    <SkillExecutionEntry
                      key={execution.id}
                      skillId={skill.id}
                      execution={execution}
                      onChanged={() => loadExecutions()}
                    />
                  ))
                )}
                {nextExecution && (
                  <Button
                    disabled={busy}
                    onClick={() => {
                      setBusy(true);
                      void loadExecutions(nextExecution)
                        .catch((failure) => setError(errorMessage(failure)))
                        .finally(() => setBusy(false));
                    }}
                  >
                    이전 실행 더 보기
                  </Button>
                )}
              </section>
            </>
          )}
          {error && (
            <>
              <ErrorNotice>{error}</ErrorNotice>
              {versions.length === 0 && (
                <Button onClick={() => setReload((value) => value + 1)}>다시 불러오기</Button>
              )}
            </>
          )}
          {notice && <p role="status">{notice}</p>}
        </div>
        <footer>
          <Button disabled={busy} onClick={onClose}>
            닫기
          </Button>
        </footer>
      </div>
    </EditDialog>
  );
}
