import { File, RefreshCw, X } from 'lucide-react';
import { IconButton } from './primitives';
export type DraftAttachmentView = Readonly<{
  id: string; name: string; status: 'ready' | 'uploading' | 'stored'; progress: number | null;
  error: string; canRetry: boolean; canRemove: boolean;
}>;
export function DraftAttachmentsView({ drafts, onRetry, onRemove }: Readonly<{
  drafts: readonly DraftAttachmentView[]; onRetry: (id: string) => void; onRemove: (id: string) => void;
}>) {
  return <div className="draft-attachments">{drafts.map(draft => <div className="draft-file" key={draft.id}>
    <File size={15} /><span>{draft.name}<small>{draft.status === 'ready' ? '첨부 준비됨'
      : draft.progress !== null ? `업로드 ${draft.progress}%${draft.progress === 100 ? ' · 서버 확인 중' : ''}`
        : draft.error || '기기에 보관됨 · 업로드 필요'}</small></span>
    {draft.canRetry && <IconButton type="button" label={`${draft.name} 업로드 다시 시도`} onClick={() => onRetry(draft.id)}><RefreshCw size={14} /></IconButton>}
    <IconButton type="button" label={`${draft.name} 첨부 제거`} disabled={!draft.canRemove} onClick={() => onRemove(draft.id)}><X size={14} /></IconButton>
  </div>)}</div>;
}
