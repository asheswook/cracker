import { useEffect, useRef, useState } from 'react';
import type { ClipboardEvent, DragEvent } from 'react';
import { z } from 'zod';
import { addFiles } from './attachmentDrafts';
import { pasteNeedsAttachment, plainPaste } from './composer-paste';
import { errorToasts } from './error-toasts';

const NativePasteError = z.object({ scope: z.string(), message: z.string().max(2048) });
const carriesFiles = (types: readonly string[]) => types.includes('Files');

export function useComposerPaste(scope: string, editable: boolean, addingFiles: boolean, onBusy: (busy: boolean) => void) {
  const pending = useRef(false);
  const depth = useRef(0);
  const [dragging, setDragging] = useState(false);
  useEffect(() => {
    const report = (event: Event) => {
      if (!(event instanceof CustomEvent)) return;
      const value = NativePasteError.safeParse(event.detail);
      if (value.success && value.data.scope === scope) errorToasts.show(value.data.message);
    };
    window.addEventListener('assistant-composer-paste-error', report);
    return () => window.removeEventListener('assistant-composer-paste-error', report);
  }, [scope]);
  useEffect(() => { if (!editable) { depth.current = 0; setDragging(false); } }, [editable]);

  const attach = (files: File[], busyMessage: string) => {
    if (!files.length) return;
    if (addingFiles || pending.current) { errorToasts.show(busyMessage); return; }
    pending.current = true;
    onBusy(true);
    void addFiles(files)
      .catch((error: unknown) => errorToasts.show(error instanceof Error ? error.message : '파일을 첨부하지 못했어요.'))
      .finally(() => { pending.current = false; onBusy(false); });
  };

  const paste = (event: ClipboardEvent<HTMLTextAreaElement>) => {
    if (!editable) return;
    const files = Array.from(event.clipboardData.files);
    if (files.length) {
      event.preventDefault();
      attach(files, '파일 첨부가 끝난 뒤 다시 붙여넣어 주세요.');
      return;
    }
    if (!event.clipboardData.types.includes('text/plain')) return;
    const text = plainPaste(event.clipboardData.getData('text/plain'));
    if (!pasteNeedsAttachment(text)) return;
    event.preventDefault();
    attach([new File([text], 'pasted-text.txt', { type: 'text/plain' })], '파일 첨부가 끝난 뒤 다시 붙여넣어 주세요. 원문은 클립보드에 유지됩니다.');
  };

  const drop = {
    onDragEnter: (event: DragEvent<HTMLElement>) => {
      if (!editable || !carriesFiles(event.dataTransfer.types)) return;
      event.preventDefault();
      depth.current += 1;
      setDragging(true);
    },
    onDragOver: (event: DragEvent<HTMLElement>) => {
      if (!editable || !carriesFiles(event.dataTransfer.types)) return;
      event.preventDefault();
      event.dataTransfer.dropEffect = 'copy';
    },
    onDragLeave: (event: DragEvent<HTMLElement>) => {
      if (!carriesFiles(event.dataTransfer.types)) return;
      depth.current = Math.max(0, depth.current - 1);
      if (!depth.current) setDragging(false);
    },
    onDrop: (event: DragEvent<HTMLElement>) => {
      if (!carriesFiles(event.dataTransfer.types)) return;
      event.preventDefault();
      depth.current = 0;
      setDragging(false);
      if (editable) attach(Array.from(event.dataTransfer.files), '파일 첨부가 끝난 뒤 다시 놓아 주세요.');
    },
  };
  return { paste, drop, dragging };
}
