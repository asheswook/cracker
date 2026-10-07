import { ArrowLeft } from 'lucide-react';
export function ArchiveBanner({ onReturn, placeholder = false }: Readonly<{ onReturn: () => void; placeholder?: boolean }>) {
  return <div className="archive-banner" aria-hidden={placeholder || undefined} inert={placeholder} style={placeholder ? { visibility: 'hidden' } : undefined}><span>이전 대화 기록</span>
    <button type="button" disabled={placeholder} onClick={onReturn}><ArrowLeft size={14} /> 메시지로 돌아가기</button>
  </div>;
}
