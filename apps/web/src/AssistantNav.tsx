import { memo } from 'react';
import {
  SlidersHorizontal,
  MessageCircle,
  CalendarDays,
  Layers3,
  ListChecks,
  LogOut,
  Monitor,
  X,
  History,
  Rss,
} from 'lucide-react';
import { Mark, IconButton } from './primitives';
export type Panel = 'computer' | 'attention' | 'tasks' | 'schedules' | 'memory' | 'settings' | 'history';
const entries = [
  { panel: 'attention', label: '피드', icon: Rss },
  { panel: 'tasks', label: '맡긴 일', icon: ListChecks },
  { panel: 'schedules', label: '예약', icon: CalendarDays },
  { panel: 'memory', label: '기억', icon: Layers3 },
  { panel: 'computer', label: '컴퓨터', icon: Monitor },
  { panel: 'history', label: '이전 대화 기록', icon: History },
  { panel: 'settings', label: '설정', icon: SlidersHorizontal },
] as const;
/** Badge text: a count, capped so it stays a small pill. */
export const badgeText = (n: number) => (n > 99 ? '99+' : String(n));
/**
 * The left sidebar: every destination, each one a full page in the main area (on the web).
 * 대화 is the conversation itself; 피드 carries a count of what waits on the user.
 */
export const AssistantNav = memo(function AssistantNav({
  name,
  panel,
  badge = 0,
  onHome,
  onPanel,
  onClose,
  onLogout,
}: {
  name: string;
  panel: Panel | null;
  badge?: number;
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
        <span className="rail-name">{name}</span>
        <IconButton label="메뉴 닫기" className="mobile-only" onClick={onClose}>
          <X size={18} />
        </IconButton>
      </div>
      <nav className="utility-nav" aria-label="어시스턴트">
        <button type="button" title={`${name}와 대화`} aria-label="대화" aria-current={panel === null ? 'page' : undefined} onClick={onHome}>
          <MessageCircle size={20} aria-hidden="true" />
          <span className="nav-label">대화</span>
        </button>
        {entries.map(({ panel: value, label, icon: Icon }) => {
          const count = value === 'attention' ? badge : 0;
          return (
            <button
              type="button"
              key={value}
              aria-label={count ? `${label}, 확인할 것 ${count}개` : label}
              title={label}
              aria-current={panel === value ? 'page' : undefined}
              onClick={() => onPanel(value)}
            >
              <Icon size={20} aria-hidden="true" />
              <span className="nav-label">{label}</span>
              {count > 0 && <sup className="nav-badge" aria-hidden="true">{badgeText(count)}</sup>}
            </button>
          );
        })}
      </nav>
      <div className="rail-footer">
        <IconButton label="로그아웃" onClick={onLogout}>
          <LogOut size={18} />
        </IconButton>
      </div>
    </aside>
  );
});
