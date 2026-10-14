import { useId, useRef, useState } from 'react';
import type { AssistantAppearance } from './types';
import { AppearanceOptions } from './AppearanceOptions';
import { blushLabel } from './catalog';

const tabs = [{ id: 'biscuit', label: '과자' }, { id: 'color', label: '색상' }, { id: 'eyes', label: '눈' }, { id: 'accessory', label: '액세서리' }] as const;
export function AppearanceControls({ draft, onChange, disabled }: {
  readonly draft: AssistantAppearance;
  readonly onChange: (value: AssistantAppearance) => void;
  readonly disabled: boolean;
}) {
  const [tab, setTab] = useState<typeof tabs[number]['id']>('biscuit');
  const refs = useRef<(HTMLButtonElement | null)[]>([]);
  const id = useId();
  return <div className="appearance-controls">
    <div className="appearance-tabs" role="tablist" aria-label="외형 항목">
      {tabs.map((item, index) => <button type="button" role="tab" key={item.id} id={`${id}-${item.id}`} aria-selected={tab === item.id} tabIndex={tab === item.id ? 0 : -1} aria-controls={`${id}-panel`} ref={node => { refs.current[index] = node; }} onClick={() => setTab(item.id)} onKeyDown={event => {
        const next = event.key === 'ArrowRight' ? (index + 1) % tabs.length : event.key === 'ArrowLeft' ? (index + tabs.length - 1) % tabs.length : event.key === 'Home' ? 0 : event.key === 'End' ? tabs.length - 1 : null;
        if (next === null) return;
        event.preventDefault();
        const target = tabs[next];
        if (target) { setTab(target.id); refs.current[next]?.focus(); }
      }}>{item.label}</button>)}
    </div>
    <div className="appearance-fields" role="tabpanel" id={`${id}-panel`} aria-labelledby={`${id}-${tab}`}>
      {tab === 'biscuit' && <AppearanceOptions field="biscuit" title="과자" draft={draft} onChange={onChange} disabled={disabled} />}
      {tab === 'color' && <AppearanceOptions field="color" title="색상" draft={draft} onChange={onChange} disabled={disabled} />}
      {tab === 'eyes' && <><AppearanceOptions field="eyes" title="눈" draft={draft} onChange={onChange} disabled={disabled} />
        <label className="appearance-switch"><span>{blushLabel}</span><input type="checkbox" role="switch" checked={draft.blush} disabled={disabled} onChange={event => onChange({ ...draft, blush: event.target.checked })} /></label></>}
      {tab === 'accessory' && <AppearanceOptions field="accessory" title="액세서리" draft={draft} onChange={onChange} disabled={disabled} />}
    </div>
  </div>;
}
