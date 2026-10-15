import { useEffect } from 'react';
import type { RefObject } from 'react';
import { useMotionValue, useMotionValueEvent } from 'motion/react';
import { useSwipeDismiss } from './useSwipeDismiss';

export function useDrawerSwipe(dialog: RefObject<HTMLDialogElement | null>, open: boolean, onClose: () => void) {
  const progress = useMotionValue(1);
  useMotionValueEvent(progress, 'change', value => {
    const element = dialog.current;
    if (!element) return;
    element.style.setProperty('--drawer-progress', String(value));
    element.toggleAttribute('data-dragging', value < 1 && value > 0);
  });
  useEffect(() => {
    if (!open) return;
    progress.jump(1);
    const element = dialog.current;
    element?.style.removeProperty('--drawer-progress');
    element?.removeAttribute('data-dragging');
  }, [open, progress, dialog]);
  return useSwipeDismiss({
    progress,
    direction: 'left',
    enabled: open,
    onDismiss: () => {
      const element = dialog.current;
      element?.removeAttribute('data-dragging');
      element?.style.removeProperty('--drawer-progress');
      onClose();
    },
  });
}
