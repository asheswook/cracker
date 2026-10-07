import { Plus, X, LockKeyhole } from 'lucide-react';
import { Button, IconButton } from '../primitives';
import type { SecretField, SecretMode } from './types';
export function SecretFields({
  mode,
  onMode,
  fields,
  onFields,
  savedKeys,
  transport,
}: {
  mode: SecretMode;
  onMode: (mode: SecretMode) => void;
  fields: SecretField[];
  onFields: (fields: SecretField[]) => void;
  savedKeys: string[];
  transport: 'stdio' | 'http';
}) {
  return (
    <fieldset className="secret-fields">
      <legend>
        <LockKeyhole size={14} />
        {transport === 'http' ? '인증 헤더' : '환경변수'}
      </legend>
      <p className="field-help">값은 저장할 때만 전송하고 다시 표시하지 않아요.</p>
      {savedKeys.length > 0 && <p className="saved-secret-keys">저장된 키: {savedKeys.join(', ')}</p>}
      <label>
        비밀값 처리
        <select value={mode} onChange={(e) => onMode(e.target.value as SecretMode)}>
          <option value="keep">저장된 값 유지</option>
          <option value="replace">새 값으로 전체 교체</option>
          <option value="clear">저장된 값 모두 삭제</option>
        </select>
      </label>
      {mode === 'clear' && <p className="field-help">저장하면 기존 비밀값이 모두 삭제돼요.</p>}
      {mode === 'replace' && (
        <>
          <p className="field-help">입력한 키와 값만 저장돼요. 유지할 키도 새 값을 입력해 주세요.</p>
          {fields.map((field, index) => (
            <div className="secret-field-row" key={field.id}>
              <label>
                키 {index + 1}
                <input
                  required
                  maxLength={100}
                  pattern="[A-Za-z_][A-Za-z0-9_-]*"
                  value={field.key}
                  placeholder={transport === 'http' ? 'Authorization' : 'API_TOKEN'}
                  onChange={(e) =>
                    onFields(fields.map((f) => (f.id === field.id ? { ...f, key: e.target.value } : f)))
                  }
                />
              </label>
              <label>
                새 값 {index + 1}
                <input
                  type="password"
                  autoComplete="new-password"
                  required
                  maxLength={8192}
                  value={field.value}
                  onChange={(e) =>
                    onFields(fields.map((f) => (f.id === field.id ? { ...f, value: e.target.value } : f)))
                  }
                />
              </label>
              <IconButton
                type="button"
                label={`비밀값 ${index + 1} 제거`}
                onClick={() => onFields(fields.filter((f) => f.id !== field.id))}
              >
                <X size={15} />
              </IconButton>
            </div>
          ))}
          <Button
            type="button"
            className="small-button"
            disabled={fields.length >= 30}
            onClick={() => onFields([...fields, { id: crypto.randomUUID(), key: '', value: '' }])}
          >
            <Plus size={14} />키 추가
          </Button>
        </>
      )}
    </fieldset>
  );
}
