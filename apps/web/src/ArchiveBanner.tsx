import { ArrowLeft } from 'lucide-react';
export function ArchiveBanner({ onReturn, placeholder = false }: Readonly<{ onReturn: () => void; placeholder?: boolean }>) {
  return <div className="archive-banner" aria-hidden={placeholder || undefined} inert={placeholder} style={placeholder ? { visibility: 'hidden' } : undefined}>
    <button type="button" disabled={placeholder} onClick={onReturn}><ArrowLeft size={16} aria-hidden="true" />지금 대화로</button>
  </div>;
}
