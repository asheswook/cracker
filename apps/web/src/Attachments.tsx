import { DraftAttachmentsView } from './DraftAttachmentsView';
import type { DraftAttachmentView } from './DraftAttachmentsView';
import { useRef, type RefObject } from 'react';
import { Plus } from 'lucide-react';
import { ArtifactCard } from './ArtifactCard';
import { client } from './store';
import type { Artifact } from './types';
import { addFiles, removeDrafts, uploadDraft } from './attachmentDrafts';
import type { UploadDraft } from './attachmentDrafts';
import { IconButton } from './primitives';
export function Attachments({ items }: { items: Artifact[] | undefined }) {
  return items?.length ? (
    <div className="attachments">
      {items.map((item) => (
        <ArtifactCard key={item.id} artifact={item} />
      ))}
    </div>
  ) : null;
}
export function AttachmentPicker({
  disabled,
  onError,
  onBusy,
  inputRef,
}: {
  disabled: boolean;
  onError: (error: string) => void;
  onBusy: (busy: boolean) => void;
  inputRef?: RefObject<HTMLInputElement | null>;
}) {
  const input = useRef<HTMLInputElement>(null);
  const pickerScope = useRef('');
  const currentScope = () => `${client.snapshot().workspace}:${client.snapshot().selected}`;
  return (
    <>
      <input
        ref={inputRef ?? input}
        type="file"
        multiple
        disabled={disabled}
        onClick={() => { pickerScope.current = currentScope(); }}
        hidden
        aria-label="첨부 파일 선택"
        onChange={(event) => {
          const files = Array.from(event.target.files ?? []);
          event.target.value = '';
          if (pickerScope.current !== currentScope()) {
            onError('대화가 바뀌었어요. 파일을 다시 선택해 주세요.');
            return;
          }
          onError('');
          onBusy(true);
          void addFiles(files)
            .catch((error) => onError(error instanceof Error ? error.message : '파일을 저장하지 못했어요.'))
            .finally(() => onBusy(false));
        }}
      />
      <IconButton type="button" label="파일 첨부" disabled={disabled} onClick={() => (inputRef ?? input).current?.click()}>
        <Plus size={20} />
      </IconButton>
    </>
  );
}
export function draftAttachmentViews(drafts: readonly UploadDraft[], progress: (id: UploadDraft['id']) => number | undefined): DraftAttachmentView[] {
  return drafts.map(draft => {
    const percent = progress(draft.id);
    return { id: draft.id, name: draft.file.name, status: draft.artifact ? 'ready' : percent !== undefined ? 'uploading' : 'stored',
      progress: percent ?? null, error: draft.error ?? '', canRetry: !draft.artifact && percent === undefined, canRemove: true };
  });
}
export function DraftAttachments({ drafts, progress, onError }: {
  drafts: UploadDraft[]; progress: (id: UploadDraft['id']) => number | undefined; onError: (message: string) => void;
}) {
  return <DraftAttachmentsView drafts={draftAttachmentViews(drafts, progress)} onRetry={id => {
    const draft = drafts.find(item => item.id === id);
    if (draft) void uploadDraft(draft).catch(() => onError('파일 상태를 저장하지 못했어요.'));
  }} onRemove={id => {
    const draft = drafts.find(item => item.id === id);
    if (draft) void removeDrafts([draft.id]).catch(() => onError('첨부 제거를 저장하지 못했어요.'));
  }} />;
}
