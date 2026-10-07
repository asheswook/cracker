import { useRef, useState } from 'react';
import { http, errorMessage } from '../api';
import { Button, ErrorNotice } from '../primitives';
import { checkState, executionState, resultUrl } from './workflow-types';
import type { SkillExecution } from './workflow-types';

export function SkillExecutionEntry({
  skillId,
  execution,
  onChanged,
}: {
  skillId: string;
  execution: SkillExecution;
  onChanged: () => Promise<void>;
}) {
  const [criterion, setCriterion] = useState(''),
    [observed, setObserved] = useState(''),
    [status, setStatus] = useState<'pass' | 'fail' | 'unknown'>('unknown');
  const [busy, setBusy] = useState(false),
    [error, setError] = useState('');
  const attempt = useRef<{ body: string; id: string } | null>(null);
  const record = async () => {
    if (!execution.result_message_id) return;
    const body = {
      criterion: criterion.trim(),
      observed: observed.trim(),
      status,
      source_message_id: execution.result_message_id,
    };
    const serialized = JSON.stringify(body);
    if (attempt.current?.body !== serialized) attempt.current = { body: serialized, id: crypto.randomUUID() };
    setBusy(true);
    setError('');
    try {
      await http.post(`/v1/extensions/skills/${skillId}/executions/${execution.id}/checks`, {
        json: { ...body, client_check_id: attempt.current.id },
      });
      await onChanged();
      setCriterion('');
      setObserved('');
      attempt.current = null;
    } catch (failure) {
      setError(errorMessage(failure));
    } finally {
      setBusy(false);
    }
  };
  return (
    <details className="skill-execution">
      <summary>
        버전 {execution.revision} · {executionState[execution.task.state]} ·{' '}
        {new Date(execution.created_at).toLocaleString('ko-KR')}
      </summary>
      <p>
        {execution.kind === 'test' ? '직접 실행' : '예약 실행'} ·{' '}
        {execution.loaded_at
          ? `버전 ${execution.revision} 지침 로드됨 · ${new Date(execution.loaded_at).toLocaleString('ko-KR')}`
          : '지침 로드 기록 없음'}
      </p>
      <div className="workflow-links">
        <a href={resultUrl(execution.conversation_id, execution.input_message_id)} target="_blank" rel="noopener" title="새 탭에서 열기">입력 원문</a>
        {execution.result_message_id && (
          <a href={resultUrl(execution.conversation_id, execution.result_message_id)} target="_blank" rel="noopener" title="새 탭에서 열기">결과 원문·파일</a>
        )}
      </div>
      <h4>사용자가 기록한 점검</h4>
      {execution.checks.length === 0 ? (
        <p>아직 검증하지 않음</p>
      ) : (
        <ul>
          {execution.checks.map((check) => (
            <li key={check.id}>
              <strong>
                {checkState[check.status]} · {check.criterion}
              </strong>
              <p>{check.observed}</p>
              <small>사용자 확인 · {new Date(check.created_at).toLocaleString('ko-KR')}</small> ·{' '}
              <a href={resultUrl(execution.conversation_id, check.source_message_id)} target="_blank" rel="noopener" title="새 탭에서 열기">확인한 결과</a>
            </li>
          ))}
        </ul>
      )}
      <p className="field-help">
        실행 종료나 지침 로드는 결과의 정확성을 보장하지 않아요. 아래 기록은 사용자의 판단이며 스킬 전체나
        다음 실행을 인증하지 않아요.
      </p>
      {execution.loaded_at && execution.result_message_id ? (
        <form
          onSubmit={(event) => {
            event.preventDefault();
            void record();
          }}
          className="workflow-check-form"
        >
          <fieldset disabled={busy}>
            <label>
              확인 기준
              <input
                required
                maxLength={2000}
                value={criterion}
                onChange={(e) => setCriterion(e.target.value)}
              />
            </label>
            <label>
              관찰한 결과
              <textarea
                required
                maxLength={4000}
                value={observed}
                onChange={(e) => setObserved(e.target.value)}
              />
            </label>
            <label>
              점검 결과
              <select value={status} onChange={(e) => setStatus(e.target.value as typeof status)}>
                <option value="unknown">확인 불가</option>
                <option value="pass">근거 확인</option>
                <option value="fail">불일치</option>
              </select>
            </label>
          </fieldset>
          {error && <ErrorNotice>{error}</ErrorNotice>}
          <Button busy={busy} disabled={!criterion.trim() || !observed.trim()} type="submit">
            사용자 점검 기록
          </Button>
        </form>
      ) : (
        <p className="field-help">지침 로드 기록과 어시스턴트 결과가 있어야 점검을 기록할 수 있어요.</p>
      )}
    </details>
  );
}
