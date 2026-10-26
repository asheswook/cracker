import { useEffect, useState } from 'react';
import { CalendarDays, ChevronLeft, ChevronRight, Ellipsis, ListChecks, LogOut, MessageCircle, Rss } from 'lucide-react';
import type { ReactNode } from 'react';
import type { Panel } from './AssistantNav';
import { badgeText } from './AssistantNav';
import { panels } from './InspectorHeader';
import './app-nav.css';

/** What lives behind 더보기 on a phone; the sidebar shows them directly. */
export const morePanels = ['memory', 'computer', 'history', 'settings'] as const satisfies readonly Panel[];
export type View = Panel | 'more' | null;
const inMore = (view: View) => view === 'more' || (morePanels as readonly string[]).includes(view ?? '');

/** iOS-style: while typing, the keyboard owns the bottom edge, so the tab bar steps aside. */
function useTyping() {
  const [typing, setTyping] = useState(false);
  useEffect(() => {
    const field = (t: EventTarget | null) => t instanceof HTMLElement && (t.matches('textarea, input:not([type=checkbox], [type=radio], [type=button], [type=submit], [type=range])') || t.isContentEditable);
    const coarse = matchMedia('(pointer: coarse)');
    const into = (e: FocusEvent) => { if (coarse.matches && field(e.target)) setTyping(true); };
    const out = (e: FocusEvent) => { if (!field(e.relatedTarget)) setTyping(false); };
    document.addEventListener('focusin', into);
    document.addEventListener('focusout', out);
    return () => { document.removeEventListener('focusin', into); document.removeEventListener('focusout', out); };
  }, []);
  return typing;
}

/** Phone-width primary navigation (web only; the native app draws its own tab bar). */
export function BottomTabs({ view, badge, onChat, onView }: {
  readonly view: View;
  readonly badge: number;
  readonly onChat: () => void;
  readonly onView: (view: Panel | 'more') => void;
}) {
  const typing = useTyping();
  const tabs = [
    { key: 'chat', label: '대화', icon: MessageCircle, active: view === null, go: onChat },
    { key: 'attention', label: '피드', icon: Rss, active: view === 'attention', go: () => onView('attention'), badge },
    { key: 'tasks', label: '맡긴 일', icon: ListChecks, active: view === 'tasks', go: () => onView('tasks') },
    { key: 'schedules', label: '예약', icon: CalendarDays, active: view === 'schedules', go: () => onView('schedules') },
    { key: 'more', label: '더보기', icon: Ellipsis, active: inMore(view), go: () => onView('more') },
  ];
  return (
    <nav className="tabbar" aria-label="주요 메뉴" data-hidden={typing || undefined}>
      {tabs.map(({ key, label, icon: Icon, active, go, badge: count }) => (
        <button key={key} type="button" className="tabbar-item" aria-current={active ? 'page' : undefined}
          aria-label={count ? `${label}, 확인할 것 ${count}개` : label} onClick={go}>
          <span className="tabbar-icon" aria-hidden="true">
            <Icon size={23} strokeWidth={active ? 2.2 : 1.8} />
            {!!count && <span className="tabbar-badge">{badgeText(count)}</span>}
          </span>
          <span className="tabbar-label" aria-hidden="true">{label}</span>
        </button>
      ))}
    </nav>
  );
}

/** The 더보기 page: the remaining destinations as a plain grouped list. */
export function MoreList({ onView, onLogout }: { readonly onView: (panel: Panel) => void; readonly onLogout: () => void }) {
  return (
    <div className="more-list">
      <ul>
        {morePanels.map(value => {
          const { title, icon: Icon } = panels[value];
          return (
            <li key={value}>
              <button type="button" onClick={() => onView(value)}>
                <span className="more-icon" aria-hidden="true"><Icon size={18} /></span>
                <span>{title}</span>
                <ChevronRight size={16} aria-hidden="true" className="more-chevron" />
              </button>
            </li>
          );
        })}
      </ul>
      <ul>
        <li>
          <button type="button" className="more-danger" onClick={onLogout}>
            <span className="more-icon" aria-hidden="true"><LogOut size={18} /></span>
            <span>로그아웃</span>
          </button>
        </li>
      </ul>
    </div>
  );
}

/** A full-page destination: a plain large title (and, under 더보기, a way back), then the content. */
export function DestinationPage({ title, panel, onBack, children }: {
  readonly title: string;
  readonly panel: string;
  readonly onBack?: (() => void) | undefined;
  readonly children: ReactNode;
}) {
  return (
    <section className="page-surface" data-panel={panel} aria-labelledby="page-title">
      <header className="page-header">
        {onBack && (
          <button type="button" className="page-back" onClick={onBack}>
            <ChevronLeft size={20} aria-hidden="true" />더보기
          </button>
        )}
        <h1 id="page-title" tabIndex={-1}>{title}</h1>
      </header>
      <div className="page-body">{children}</div>
    </section>
  );
}
