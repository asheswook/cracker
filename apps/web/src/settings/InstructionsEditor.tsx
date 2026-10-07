import { useEffect, useId, useRef, useState } from 'react';
import { HTTPError } from 'ky';
import { http, read, errorMessage } from '../api';
import { Button, ErrorNotice } from '../primitives';
import { Instructions, type Persona } from './types';
import { EditDialog } from './EditDialog';
import { SettingsConflict } from './SettingsConflict';
export function InstructionsEditor({
  value,
  initialPersona,
  onClose,
  onSaved,
}: {
  readonly value: Instructions;
  readonly initialPersona: Persona | null;
  readonly onClose: () => void;
  readonly onSaved: (value: Instructions) => void;
}) {
  const [draft, setDraft] = useState({ ...value, persona: initialPersona ?? value.persona }),
    [busy, setBusy] = useState(false),
    [error, setError] = useState('');
  const [base, setBase] = useState(value);
  const [stale, setStale] = useState(false);
  const [latest, setLatest] = useState<Instructions | null>(null);
  const [confirmDiscard, setConfirmDiscard] = useState(false);
  const confirmation = useRef<HTMLDialogElement>(null);
  const confirmationId = useId();
  const nameInput = useRef<HTMLInputElement>(null);
  const errorRegion = useRef<HTMLDivElement>(null);
  useEffect(() => { if (error) errorRegion.current?.focus(); }, [error]);
  useEffect(() => {
    if (!confirmDiscard) return;
    const dialog = confirmation.current;
    const trigger = document.activeElement instanceof HTMLElement ? document.activeElement : null;
    dialog?.showModal();
    return () => {
      dialog?.close();
      trigger?.focus({ preventScroll: true });
    };
  }, [confirmDiscard]);
  const dirty =
    draft.instructions !== base.instructions ||
    draft.persona.name !== base.persona.name ||
    draft.persona.role !== base.persona.role ||
    draft.persona.style !== base.persona.style;
  const changed = initialPersona !== null || dirty;
  const requestClose = () => {
    if (busy) return;
    if (dirty) setConfirmDiscard(true);
    else onClose();
  };
  const compare = async () => {
    setBusy(true);
    setError('');
    try { setLatest(await read('/v1/settings', Instructions)); }
    catch (failure) { setError(`최신 설정을 불러오지 못했어요. 초안은 유지돼요. ${errorMessage(failure)}`); }
    finally { setBusy(false); }
  };
  const save = async () => {
    if (busy || stale) return;
    setBusy(true);
    setError('');
    try {
      const result = Instructions.parse(
        await http
          .put('/v1/settings', { json: {
            expected_revision: base.revision,
            persona: draft.persona,
            ...(initialPersona !== null ? { onboarding: { status: 'completed' } } : {}),
            ...(draft.instructions !== base.instructions ? { instructions: draft.instructions } : {}),
          } })
          .json<unknown>(),
      );
      onSaved(result);
    } catch (failure) {
      if (failure instanceof HTTPError && failure.response.status === 409) {
        setStale(true);
        await compare();
      } else setError(errorMessage(failure));
    } finally {
      setBusy(false);
    }
  };
  return (
    <EditDialog title="페르소나 편집" busy={busy} onClose={requestClose} onKeyDown={event => {
      if (event.key !== 'Escape' || event.nativeEvent.isComposing || event.defaultPrevented) return;
      event.preventDefault();
      event.stopPropagation();
      if (confirmDiscard) setConfirmDiscard(false);
      else requestClose();
    }}>
      <form
        className="settings-form"
        aria-busy={busy}
        onSubmit={(event) => {
          event.preventDefault();
          void save();
        }}
      >
        <div className="settings-form-body">
        <fieldset className="persona-edit-fields" disabled={busy || stale}>
          <p className="form-intro">
            이름과 함께 일하는 방식을 정해 주세요. 대화 전체에 저장되고, 다음 작업부터 적용돼요.
          </p>
          <label>
            이름
            <input
              ref={nameInput}
              autoFocus
              required
              maxLength={80}
              value={draft.persona.name}
              onChange={(e) => setDraft({ ...draft, persona: { ...draft.persona, name: e.target.value } })}
            />
          </label>
          <label>
            역할
            <textarea
              rows={3}
              maxLength={2000}
              value={draft.persona.role}
              onChange={(e) => setDraft({ ...draft, persona: { ...draft.persona, role: e.target.value } })}
              placeholder="예: 생각을 정리하고 실행까지 돕는 동료"
            />
          </label>
          <label>
            말투와 답변 방식
            <textarea
              rows={3}
              maxLength={2000}
              value={draft.persona.style}
              onChange={(e) => setDraft({ ...draft, persona: { ...draft.persona, style: e.target.value } })}
              placeholder="예: 편안한 존댓말로, 결론부터 간결하게"
            />
          </label>
          <label>
            기본 지침
            <textarea
              rows={6}
              maxLength={100000}
              value={draft.instructions}
              onChange={(e) => setDraft({ ...draft, instructions: e.target.value })}
              placeholder="예: 한국어로 간결하게 답하고, 파일을 수정하면 검증 결과도 알려 줘."
            />
          </label>
          <span className="field-help">
            {draft.instructions.length.toLocaleString()} / 100,000자 · 비우고 저장하면 지침이 삭제돼요.
          </span>
        </fieldset>
        {error && <div ref={errorRegion} tabIndex={-1} className="persona-save-error"><ErrorNotice>{error}</ErrorNotice></div>}
        {latest && <SettingsConflict key={latest.revision} base={base} local={draft} latest={latest} onResolve={resolved => {
          setBase(latest); setDraft(resolved); setLatest(null); setStale(false); setError('');
          requestAnimationFrame(() => nameInput.current?.focus());
        }} />}
        {stale && !latest && <Button type="button" busy={busy} onClick={() => void compare()}>최신 설정과 비교</Button>}
        </div>
        <footer>
          <Button type="button" disabled={busy} onClick={requestClose}>
            취소
          </Button>
          <Button
            type="submit"
            className="primary"
            busy={busy}
            disabled={stale || !changed || !draft.persona.name.trim()}
          >
            저장
          </Button>
        </footer>
      </form>
      {confirmDiscard && <dialog
        ref={confirmation}
        className="confirm-dialog"
        aria-labelledby={confirmationId}
        aria-describedby={`${confirmationId}-description`}
        onCancel={event => {
          event.preventDefault();
          event.stopPropagation();
          setConfirmDiscard(false);
        }}
      >
        <h2 id={confirmationId}>변경 내용을 버릴까요?</h2>
        <p id={`${confirmationId}-description`}>저장하지 않은 변경 내용이 사라져요.</p>
        <div>
          <Button type="button" autoFocus onClick={() => setConfirmDiscard(false)}>계속 편집</Button>
          <Button type="button" className="danger" onClick={onClose}>변경 내용 버리기</Button>
        </div>
      </dialog>}
    </EditDialog>
  );
}
