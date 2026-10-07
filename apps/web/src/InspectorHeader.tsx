import { CalendarDays, History, Layers3, ListChecks, Monitor, SlidersHorizontal, X } from 'lucide-react';
import type { Panel } from './AssistantNav';
import { IconButton } from './primitives';

const panels = {
  computer: { title: '컴퓨터', icon: Monitor },
  tasks: { title: '맡긴 일', icon: ListChecks },
  schedules: { title: '예약', icon: CalendarDays },
  memory: { title: '기억', icon: Layers3 },
  settings: { title: '설정', icon: SlidersHorizontal },
  history: { title: '이전 대화 기록', icon: History },
} as const satisfies Record<Panel, { title: string; icon: typeof Monitor }>;

export function InspectorHeader({ panel, onClose }: {
  readonly panel: Panel;
  readonly onClose: () => void;
}) {
  const { title, icon: Icon } = panels[panel];
  return (
    <header className="inspector-header">
      <span><Icon size={18} />{title}</span>
      <IconButton label="패널 닫기" onClick={onClose}>
        <X size={18} />
      </IconButton>
    </header>
  );
}
