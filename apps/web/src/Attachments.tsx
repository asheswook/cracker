import { DraftAttachmentsView } from './DraftAttachmentsView';
import type { DraftAttachmentView } from './DraftAttachmentsView';
import { useEffect, useRef, useState, type RefObject } from 'react';
import { Download, File, Plus } from 'lucide-react';
import { http } from './api';
import { client } from './store';
import type { Artifact } from './types';
import { addFiles, removeDrafts, uploadDraft } from './attachmentDrafts';
import type { UploadDraft } from './attachmentDrafts';
import { IconButton } from './primitives';
const raster = new Set(['image/png', 'image/jpeg', 'image/webp', 'image/gif']);
function Attachment({ artifact }: { artifact: Artifact }) {
  const [source, setSource] = useState('');
  const [error, setError] = useState('');
  useEffect(() => {
    if (artifact.state !== 'ready' || !raster.has(artifact.media_type)) return;
    const abort = new AbortController();
    let url = '';
    void http
      .get(`/v1/artifacts/${artifact.id}/content`, { signal: abort.signal })
      .blob()
      .then((blob) => {
        if (abort.signal.aborted) return;
        url = URL.createObjectURL(new Blob([blob], { type: artifact.media_type }));
        setSource(url);
      })
      .catch(() => {
        if (!abort.signal.aborted) setError('미리보기를 불러오지 못했어요.');
      });
    return () => {
      abort.abort();
      if (url) URL.revokeObjectURL(url);
    };
  }, [artifact.id, artifact.media_type, artifact.state]);
  if (artifact.state === 'deleted')
    return <span className="attachment-deleted">삭제된 파일 · {artifact.name}</span>;
  return (
    <div className="attachment-card">
      {source && (
        <img
          className="attachment-preview"
          src={source}
          alt={artifact.name}
          onError={() => {
            setSource('');
            setError('이미지를 표시할 수 없어요.');
          }}
        />
      )}
      <a href={`/v1/artifacts/${artifact.id}/content`} download={artifact.name}>
        <File size={16} />
        <span>
          {artifact.name}
          <small>{Math.ceil(artifact.bytes / 1024)} KB</small>
        </span>
        <Download size={15} />
      </a>
      {error && <small role="status">{error}</small>}
    </div>
  );
}
export function Attachments({ items }: { items: Artifact[] | undefined }) {
  return items?.length ? (
    <div className="attachments">
      {items.map((item) => (
        <Attachment key={item.id} artifact={item} />
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
