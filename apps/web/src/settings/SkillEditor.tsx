import { useState } from 'react';
import { HTTPError } from 'ky';
import { http, errorMessage } from '../api';
import { Button, ErrorNotice } from '../primitives';
import type { Id } from '../types';
import { Skill } from './types';
import type { SkillDraft } from './types';
import { EditDialog } from './EditDialog';
export function SkillEditor({
  vm,
  item,
  imported,
  onClose,
  onSaved,
}: {
  vm: Id;
  item: Skill | null;
  imported: SkillDraft | null;
  onClose: () => void;
  onSaved: () => void;
}) {
  const [draft, setDraft] = useState<SkillDraft>(
    () => item ?? imported ?? { name: '', description: '', content: '', enabled: false },
  );
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const save = async () => {
    if (new TextEncoder().encode(draft.content).length > 65536) {
      setError('스킬 문서는 64KB까지 저장할 수 있어요.');
      return;
    }
    setBusy(true);
    setError('');
    try {
      Skill.parse(
        (
          await http
            .post('/v1/extensions/skills', {
              json: {
                ...(item ? { id: item.id, expected_revision: item.revision } : {}),
                vm_id: vm,
                name: draft.name,
                description: draft.description,
                content: draft.content,
                enabled: draft.enabled,
              },
            })
            .json<{ skill: unknown }>()
        ).skill,
      );
      await onSaved();
    } catch (failure) {
      setError(
        failure instanceof HTTPError && failure.response.status === 409
          ? '다른 변경이 먼저 저장됐어요. 입력한 초안은 이 창에 그대로 남아 있어요. 내용을 보관한 뒤 최신 버전을 다시 열어 비교해 주세요.'
          : errorMessage(failure),
      );
    } finally {
      setBusy(false);
    }
  };
  return (
    <EditDialog title={item ? '스킬 편집' : '스킬 추가'} busy={busy} onClose={onClose}>
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
            어떤 일을 언제, 어떻게 수행할지 알려 주세요. 필요한 순간에 내용을 불러와요.
            {item
              ? ` 저장하면 버전 ${item.revision + 1}이 만들어져요. 기존 버전은 보존돼요.`
              : ' 새 스킬은 기본적으로 사용하지 않는 초안으로 저장해요.'}
          </p>
          <label>
            스킬 이름
            <input
              autoFocus
              required
              maxLength={64}
              value={draft.name}
              onChange={(e) => setDraft({ ...draft, name: e.target.value })}
              placeholder="예: 문서 검토"
            />
          </label>
          <label>
            언제 사용할까요?
            <textarea
              required
              maxLength={1000}
              rows={2}
              value={draft.description}
              onChange={(e) => setDraft({ ...draft, description: e.target.value })}
              placeholder="이 스킬을 사용할 상황을 짧게 설명해 주세요."
            />
          </label>
          <label>
            스킬 문서<span className="field-help">Markdown · 최대 64KB</span>
            <textarea
              className="code-field skill-document"
              required
              rows={12}
              value={draft.content}
              onChange={(e) => setDraft({ ...draft, content: e.target.value })}
              spellCheck={false}
              placeholder={'# 문서 검토\n\n검토할 때 따를 절차를 작성하세요.'}
            />
          </label>
          <label className="check-label">
            <input
              type="checkbox"
              checked={draft.enabled}
              onChange={(e) => setDraft({ ...draft, enabled: e.target.checked })}
            />
            이 스킬 사용하기
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
