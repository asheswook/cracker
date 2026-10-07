import { useCallback, useEffect, useRef, useState } from 'react';
import { Pencil, FileText, RefreshCw } from 'lucide-react';
import { errorMessage } from '../api';
import { LoadingSkeleton } from '../LoadingSkeleton';
import { Button, ErrorNotice } from '../primitives';
import { client } from '../store';
import './persona.css';
import type { Instructions, Persona } from './types';
import { InstructionsEditor } from './InstructionsEditor';
import { onboardingDraftKey, readOnboardingDraft } from './onboardingDraft';
export function InstructionsPanel() {
  const workspace = client.snapshot().workspace;
  const operation = useRef<AbortController | null>(null);
  const [onboardingDraft, setOnboardingDraft] = useState<Persona | null>(null);
  const [resumeDraft, setResumeDraft] = useState(false);
  const [value, setValue] = useState<Instructions | null>(null),
    [error, setError] = useState(''),
    [editing, setEditing] = useState(false),
    [notice, setNotice] = useState('');
  const load = useCallback(async (failurePrefix = '') => {
    operation.current?.abort();
    const controller = new AbortController();
    operation.current = controller;
    setError('');
    try {
      const settings = await client.refreshPersona(controller.signal);
      if (controller.signal.aborted) return;
      if (!settings) { setError('최신 설정을 확인하지 못했어요. 다시 불러와 주세요.'); return; }
      setValue(settings);
      setOnboardingDraft(
        workspace && settings.onboarding?.status !== 'completed' &&
          settings.persona.name === 'Assistant' && !settings.persona.role && !settings.persona.style
          ? readOnboardingDraft(workspace)?.persona ?? null : null,
      );
    } catch (failure) {
      if (!controller.signal.aborted) setError(failurePrefix + errorMessage(failure));
    }
  }, [workspace]);
  useEffect(() => {
    void load();
    return () => operation.current?.abort();
  }, [load]);
  return (
    <section className="instructions-panel">
      <div className="settings-intro">
        <FileText size={22} />
        <h2>페르소나</h2>
        <p>어떤 방식으로 함께 일할지 알려 주세요.</p>
      </div>
      {error && (
        <>
          <ErrorNotice>{error}</ErrorNotice>
          <Button onClick={() => void load()}>
            <RefreshCw size={14} />
            다시 불러오기
          </Button>
        </>
      )}
      {value === null && !error && (
        <LoadingSkeleton layout="persona" label="페르소나를 불러오는 중이에요." />
      )}
      {value !== null && (
        <>
          <dl className="persona-summary">
            <div>
              <dt>이름</dt>
              <dd>{value.persona.name}</dd>
            </div>
            <div>
              <dt>역할</dt>
              <dd>{value.persona.role || '정해진 역할이 없어요.'}</dd>
            </div>
            <div>
              <dt>말투와 답변 방식</dt>
              <dd>{value.persona.style || '기본 답변 방식을 사용해요.'}</dd>
            </div>
            <div>
              <dt>기본 지침</dt>
              <dd>{value.instructions || '추가 지침이 없어요.'}</dd>
            </div>
          </dl>
          <Button
            className="settings-wide-action"
            onClick={() => {
              setNotice('');
              setResumeDraft(false);
              setEditing(true);
            }}
          >
            <Pencil size={15} />
            페르소나 편집
          </Button>
          {onboardingDraft && (
            <Button className="settings-wide-action" onClick={() => {
              setNotice('');
              setResumeDraft(true);
              setEditing(true);
            }}>
              소개 초안 이어서 설정
            </Button>
          )}
        </>
      )}
      {notice && (
        <p role="status" className="settings-notice">
          {notice}
        </p>
      )}
      {editing && value !== null && (
        <InstructionsEditor
          value={value}
          initialPersona={resumeDraft ? onboardingDraft : null}
          onClose={() => setEditing(false)}
          onSaved={(next) => {
            setValue(next);
            if (next.persona.name !== 'Assistant' || next.persona.role || next.persona.style || next.onboarding?.status === 'completed') setOnboardingDraft(null);
            setEditing(false);
            setNotice('페르소나를 저장했어요. 다음에 시작하는 작업부터 적용돼요.');
            void load('저장됐지만 화면의 이름을 갱신하지 못했어요. ');
            if (resumeDraft && workspace) {
              try { localStorage.removeItem(onboardingDraftKey(workspace)); }
              catch (failure) { setError(`저장됐지만 이 기기의 소개 초안을 정리하지 못했어요. ${errorMessage(failure)}`); }
            }
          }}
        />
      )}
    </section>
  );
}
