import { useEffect, useId, useRef, useState } from 'react';
import { Button, ErrorNotice } from '../primitives';
import type { Instructions } from './types';
import { mergeSettings, settingsField, settingsFields, settingsLabels, type SettingsChoices } from './settingsMerge';
import './settings-conflict.css';

export function SettingsConflict({ base, local, latest, onResolve }: {
  readonly base: Instructions;
  readonly local: Instructions;
  readonly latest: Instructions;
  readonly onResolve: (value: Instructions) => void;
}) {
  const id = useId();
  const region = useRef<HTMLElement>(null);
  useEffect(() => { region.current?.focus(); }, []);
  const [choices, setChoices] = useState<SettingsChoices>({});
  const edit = { base, local, latest };
  const original = mergeSettings(edit);
  const resolved = mergeSettings(edit, choices);
  const updated = settingsFields.filter(field => settingsField(base, field) !== settingsField(latest, field));
  return <section ref={region} tabIndex={-1} className="settings-conflict" aria-label="페르소나 변경 내용 비교">
    <ErrorNotice>다른 기기에서 설정이 바뀌었어요. 내 초안은 유지돼요.</ErrorNotice>
    <p>최근 변경: {updated.map(field => settingsLabels[field]).join(', ') || '소개 설정'}. 겹치지 않는 변경은 함께 반영하고, 같은 항목을 다르게 수정했다면 사용할 값을 골라 주세요.</p>
    {original.conflicts.map(field => <fieldset key={field}>
      <legend>{settingsLabels[field]}</legend>
      {(['latest', 'local'] as const).map(choice => <label key={choice}>
        <span><input type="radio" name={`${id}-${field}`} value={choice} checked={choices[field] === choice}
          onChange={() => setChoices(previous => ({ ...previous, [field]: choice }))} />
          {choice === 'latest' ? '최근 저장된 값' : '내가 작성한 값'}</span>
        <span className="settings-conflict-value">{settingsField(choice === 'latest' ? latest : local, field) || '(비어 있음)'}</span>
      </label>)}
    </fieldset>)}
    <p>비교를 마친 뒤에도 저장을 눌러야 적용돼요.</p>
    <Button type="button" disabled={resolved.conflicts.length > 0} onClick={() => onResolve(resolved.merged)}>비교 마치고 계속 편집</Button>
  </section>;
}
