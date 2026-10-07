import { useEffect, useRef } from 'react';
import type { ClipboardEvent } from 'react';
import { z } from 'zod';
import { addFiles } from './attachmentDrafts';
import { pasteNeedsAttachment, plainPaste } from './composer-paste';
import { errorToasts } from './error-toasts';

const NativePasteError = z.object({ scope: z.string(), message: z.string().max(2048) });
export function useComposerPaste(scope: string, editable: boolean, addingFiles: boolean, onBusy: (busy: boolean) => void) {
  const pending = useRef(false);
  useEffect(() => {
    const report = (event: Event) => {
      if (!(event instanceof CustomEvent)) return;
      const value = NativePasteError.safeParse(event.detail);
      if (value.success && value.data.scope === scope) errorToasts.show(value.data.message);
    };
    window.addEventListener('assistant-composer-paste-error', report);
    return () => window.removeEventListener('assistant-composer-paste-error', report);
  }, [scope]);
  return (event: ClipboardEvent<HTMLTextAreaElement>) => {
    if (!editable || !event.clipboardData.types.includes('text/plain')) return;
    const text = plainPaste(event.clipboardData.getData('text/plain'));
    if (!pasteNeedsAttachment(text)) return;
    event.preventDefault();
    if (addingFiles || pending.current) { errorToasts.show('파일 첨부가 끝난 뒤 다시 붙여넣어 주세요. 원문은 클립보드에 유지됩니다.'); return; }
    pending.current = true;
    onBusy(true);
    void addFiles([new File([text], 'pasted-text.txt', { type: 'text/plain' })])
      .catch((error: unknown) => errorToasts.show(error instanceof Error ? error.message : '붙여넣은 내용을 첨부하지 못했어요.'))
      .finally(() => { pending.current = false; onBusy(false); });
  };
}
