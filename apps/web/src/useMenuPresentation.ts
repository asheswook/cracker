import { useLayoutEffect, type RefObject } from 'react';
import { panelTransition } from './panel-transition';

export function useMenuPresentation(open: boolean, dialog: RefObject<HTMLDialogElement | null>) {
  useLayoutEffect(() => {
    const element = dialog.current;
    if (!element) return;
    const transition = panelTransition();
    const cleanup = open ? transition?.acceptedCoverCleanup('menu') : undefined;
    const covered = cleanup !== undefined;
    element.toggleAttribute('data-native-covered', covered);
    if (open) {
      if (!element.open) element.showModal();
      if (covered) transition?.complete('menu');
    } else element.close();
    return cleanup;
  }, [open, dialog]);
}
