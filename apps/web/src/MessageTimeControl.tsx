import { Clock3 } from 'lucide-react';
export function MessageTimeControl({ pinned, onToggle }: { readonly pinned: boolean; readonly onToggle: () => void }) {
  return <button type="button" className="icon-button message-time-toggle"
    aria-label={pinned ? '메시지 시간 숨기기' : '메시지 시간 보기'} title={pinned ? '메시지 시간 숨기기' : '메시지 시간 보기'}
    aria-pressed={pinned} onClick={onToggle}><Clock3 size={18} aria-hidden="true" /></button>;
}
