import { useRef } from 'react';
export type SettingsTab = 'instructions' | 'appearance' | 'models' | 'skills' | 'servers' | 'notifications';
const tabs = [
  { id: 'instructions', label: '페르소나' },
  { id: 'appearance', label: '외형' },
  { id: 'models', label: '모델' },
  { id: 'skills', label: '스킬' },
  { id: 'servers', label: 'MCP' },
  { id: 'notifications', label: '알림' },
] as const;
export function SettingsTabs({
  id,
  selected,
  onChange,
}: {
  id: string;
  selected: SettingsTab;
  onChange: (tab: SettingsTab) => void;
}) {
  const refs = useRef<(HTMLButtonElement | null)[]>([]);
  return (
    <div className="settings-tabs" role="tablist" aria-label="설정 항목">
      {tabs.map((tab, index) => (
        <button
          key={tab.id}
          id={`${id}-${tab.id}`}
          type="button"
          role="tab"
          aria-controls={`${id}-panel`}
          aria-selected={selected === tab.id}
          tabIndex={selected === tab.id ? 0 : -1}
          ref={(node) => {
            refs.current[index] = node;
          }}
          onClick={() => onChange(tab.id)}
          onKeyDown={(event) => {
            const next =
              event.key === 'ArrowRight'
                ? (index + 1) % tabs.length
                : event.key === 'ArrowLeft'
                  ? (index + tabs.length - 1) % tabs.length
                  : event.key === 'Home'
                    ? 0
                    : event.key === 'End'
                      ? tabs.length - 1
                      : null;
            if (next !== null) {
              event.preventDefault();
              const target = tabs[next];
              if (target) {
                onChange(target.id);
                refs.current[next]?.focus();
              }
            }
          }}
        >
          {tab.label}
        </button>
      ))}
    </div>
  );
}
