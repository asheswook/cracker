import { useEffect, useId, useRef } from 'react';
import type { KeyboardEventHandler, ReactNode } from 'react';
import { X } from 'lucide-react';
import { IconButton } from '../primitives';
export function EditDialog({
  title,
  children,
  busy = false,
  onClose,
  onKeyDown,
}: {
  title: string;
  children: ReactNode;
  busy?: boolean;
  onClose: () => void;
  onKeyDown?: KeyboardEventHandler<HTMLDialogElement>;
}) {
  const ref = useRef<HTMLDialogElement>(null);
  const id = useId();
  useEffect(() => {
    const dialog = ref.current;
    const trigger = document.activeElement instanceof HTMLElement ? document.activeElement : null;
    dialog?.showModal();
    return () => {
      dialog?.close();
      trigger?.focus();
    };
  }, []);
  return (
    <dialog
      ref={ref}
      className="settings-dialog"
      aria-labelledby={id}
      onKeyDown={onKeyDown}
      onCancel={(event) => {
        event.preventDefault();
        event.stopPropagation();
        if (!busy) onClose();
      }}
    >
      <header>
        <h2 id={id}>{title}</h2>
        <IconButton label="편집 닫기" disabled={busy} onClick={onClose}>
          <X size={18} />
        </IconButton>
      </header>
      {children}
    </dialog>
  );
}
