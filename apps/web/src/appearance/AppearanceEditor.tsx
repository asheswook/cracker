import { useEffect, useId, useLayoutEffect, useRef, useState } from 'react';
import { HTTPError } from 'ky';
import { http, errorMessage } from '../api';
import { Button, ErrorNotice } from '../primitives';
import { EditDialog } from '../settings/EditDialog';
import { AppearanceSettings, AppearanceConflict } from './types';
import { AssistantCharacter } from './AssistantCharacter';
import { AppearanceControls } from './AppearanceControls';
import { sameAppearance } from './catalog';

export function AppearanceEditor({ value, onClose, onSaved }: {
  readonly value: AppearanceSettings;
  readonly onClose: () => void;
  readonly onSaved: (value: AppearanceSettings) => void;
}) {
  const [base, setBase] = useState(value);
  const [draft, setDraft] = useState(value.appearance);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [conflict, setConflict] = useState<AppearanceSettings | null>(null);
  const [discard, setDiscard] = useState(false);
  const confirmation = useRef<HTMLDialogElement>(null);
  const feedback = useRef<HTMLDivElement>(null);
  const saving = useRef(false);
  const id = useId();
  const dirty = !sameAppearance(draft, base.appearance);
  useLayoutEffect(() => {
    if (!error && !conflict) return;
    feedback.current?.focus({ preventScroll: true });
    feedback.current?.scrollIntoView({ block: 'nearest', behavior: 'instant' });
  }, [error, conflict]);
  useEffect(() => {
    if (!discard) return;
    const dialog = confirmation.current;
    const trigger = document.activeElement instanceof HTMLElement ? document.activeElement : null;
    dialog?.showModal();
    return () => { dialog?.close(); trigger?.focus({ preventScroll: true }); };
  }, [discard]);
  const close = () => { if (!saving.current) { if (dirty) setDiscard(true); else onClose(); } };
  const save = async () => {
    if (saving.current || conflict || !dirty) return;
    saving.current = true;
    setBusy(true);
    setError('');
    try {
      const result = AppearanceSettings.parse(await http.put('/v1/appearance', {
        json: { appearance: draft, expected_revision: base.revision },
      }).json<unknown>());
      onSaved(result);
    } catch (failure) {
      if (failure instanceof HTTPError && failure.response.status === 409) {
        try {
          const parsed = AppearanceConflict.safeParse(await failure.response.json<unknown>());
          if (parsed.success) setConflict(parsed.data.current);
          else setError(errorMessage(failure));
        } catch (decodeFailure) { setError(errorMessage(decodeFailure)); }
      } else setError(errorMessage(failure));
    } finally { saving.current = false; setBusy(false); }
  };
  return <EditDialog title="외형 편집" busy={busy} onClose={close} onKeyDown={event => {
    if (event.key !== 'Escape' || event.nativeEvent.isComposing || event.defaultPrevented) return;
    event.preventDefault(); event.stopPropagation();
    if (discard) setDiscard(false); else close();
  }}>
    <form className="settings-form appearance-form" aria-busy={busy} onSubmit={event => { event.preventDefault(); void save(); }}>
      <div className="appearance-preview" aria-label="외형 미리 보기"><AssistantCharacter appearance={draft} /></div>
      <div className="settings-form-body">
        {(error || conflict) && <div ref={feedback} tabIndex={-1} className="appearance-save-feedback" role="group" aria-label={conflict ? '외형 변경 충돌' : '외형 저장 실패'}>
        {error && <ErrorNotice>{error}</ErrorNotice>}
        {conflict && <section className="appearance-conflict" aria-label="외형 변경 충돌">
          <p role="status">다른 기기에서 외형을 변경했어요. 최신 외형을 사용하거나, 내 초안을 유지한 뒤 저장할 수 있어요.</p>
          <div className="appearance-conflict-choices">
            <Button type="button" onClick={() => onSaved(conflict)}><span className="appearance-preview"><AssistantCharacter appearance={conflict.appearance} still /></span>최신 외형 사용</Button>
            <Button type="button" onClick={() => { setBase(conflict); setConflict(null); }}><span className="appearance-preview"><AssistantCharacter appearance={draft} still /></span>내 초안 유지</Button>
          </div>
        </section>}
        </div>}
        <AppearanceControls draft={draft} onChange={setDraft} disabled={busy || !!conflict} />
      </div>
      <footer><Button type="button" disabled={busy} onClick={close}>취소</Button><Button type="submit" className="primary" busy={busy} disabled={!dirty || !!conflict}>저장</Button></footer>
    </form>
    {discard && <dialog ref={confirmation} className="confirm-dialog" aria-labelledby={id} onCancel={event => { event.preventDefault(); event.stopPropagation(); setDiscard(false); }}>
      <h2 id={id}>변경 내용을 버릴까요?</h2><p>저장하지 않은 외형 변경이 사라져요.</p>
      <div><Button type="button" autoFocus onClick={() => setDiscard(false)}>계속 편집</Button><Button type="button" className="danger" onClick={onClose}>변경 내용 버리기</Button></div>
    </dialog>}
  </EditDialog>;
}
