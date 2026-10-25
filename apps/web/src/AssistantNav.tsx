import { memo } from 'react';
import {
  SlidersHorizontal,
  MessageCircle,
  CalendarDays,
  Layers3,
  ListChecks,
  LogOut,
  X,
  History,
  Inbox,
} from 'lucide-react';
import { Mark, IconButton } from './primitives';
export type Panel = 'computer' | 'attention' | 'tasks' | 'schedules' | 'memory' | 'settings' | 'history';
const entries = [
  { panel: 'attention', label: '챙길 것', icon: Inbox },
  { panel: 'tasks', label: '맡긴 일', icon: ListChecks },
  { panel: 'schedules', label: '예약', icon: CalendarDays },
  { panel: 'memory', label: '기억', icon: Layers3 },
  { panel: 'history', label: '이전 대화 기록', icon: History },
  { panel: 'settings', label: '설정', icon: SlidersHorizontal },
] as const;
export const AssistantNav = memo(function AssistantNav({
  name,
  panel,
  onHome,
  onPanel,
  onClose,
  onLogout,
}: {
  name: string;
  panel: Panel | null;
  onHome: () => void;
  onPanel: (panel: Panel) => void;
  onClose: () => void;
  onLogout: () => void;
}) {
  return (
    <aside className="sidebar assistant-rail">
      <div className="brand-row">
        <span className="rail-home" aria-hidden="true">
          <Mark />
        </span>
        <IconButton label="메뉴 닫기" className="mobile-only" onClick={onClose}>
          <X size={18} />
        </IconButton>
      </div>
      <nav className="utility-nav" aria-label="어시스턴트">
        <button type="button" title={`${name}와 대화`} aria-label="메시지" aria-pressed={panel === null} onClick={onHome}>
          <MessageCircle size={20} />
          <span>메시지</span>
        </button>
        {entries.map(({ panel: value, label, icon: Icon }) => (
          <button
            type="button"
            key={value}
            aria-label={label}
            title={label}
            aria-pressed={panel === value}
            onClick={() => onPanel(value)}
          >
            <Icon size={20} />
            <span>{label}</span>
          </button>
        ))}
      </nav>
      <div className="rail-footer">
        <IconButton label="로그아웃" onClick={onLogout}>
          <LogOut size={18} />
        </IconButton>
      </div>
    </aside>
  );
});
