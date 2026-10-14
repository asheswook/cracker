import { useEffect, useLayoutEffect, useRef, useState } from 'react';
import {
  m as Motion,
  useMotionValue,
  useTransform,
  useMotionValueEvent,
  usePresence,
  animate,
} from 'motion/react';
import { panelTransition } from './panel-transition';
import { useReducedMotion } from './useReducedMotion';
import { useSwipeDismiss } from './useSwipeDismiss';
import type { ReactNode } from 'react';
export function InspectorHost({
  children,
  onClose,
  computer = false,
  onPresented,
}: {
  children: ReactNode;
  onClose: () => void;
  computer?: boolean;
  onPresented?: () => void;
}) {
  const presented = useRef(onPresented);
  presented.current = onPresented;
  const queryText = computer ? '(max-width:999px)' : '(max-width:1100px)';
  const [overlay, setOverlay] = useState(() => matchMedia(queryText).matches);
  const dialog = useRef<HTMLDialogElement>(null);
  const reduced = useReducedMotion();
  const [present, remove] = usePresence();
  const progress = useMotionValue(0);
  const reservation = useMotionValue(0);
  const panelWidth = useMotionValue(390);
  const [{ width, gap }, setGeometry] = useState({ width: 390, gap: 12 });
  const translation = useTransform(progress, (value) => `${(1 - value) * 100}%`);
  useMotionValueEvent(progress, 'change', value => {
    dialog.current?.style.setProperty('--inspector-progress', String(value));
  });
  useMotionValueEvent(reservation, 'change', value => {
    dialog.current?.parentElement?.style.setProperty('--inspector-space', `${value}px`);
  });
  useLayoutEffect(() => {
    const shell = dialog.current?.parentElement;
    if (!shell) return;
    const measure = () => {
      const style = getComputedStyle(shell);
      const gap = Number.parseFloat(style.columnGap);
      const rail = shell.querySelector('.desktop-sidebar')?.getBoundingClientRect().width ?? 0;
      const available = shell.clientWidth - rail - gap * 2 - Number.parseFloat(style.paddingLeft) - Number.parseFloat(style.paddingRight);
      const token = (name: string) => Number.parseFloat(style.getPropertyValue(name));
      const width = computer
        ? Math.max(token('--inspector-computer-min'), Math.min(available * token('--inspector-computer-share'), available - token('--inspector-chat-min')))
        : token('--inspector-standard-width');
      setGeometry(current => current.width === width && current.gap === gap ? current : { width, gap });
    };
    measure();
    const observer = new ResizeObserver(measure);
    observer.observe(shell);
    return () => observer.disconnect();
  }, [computer]);
  useLayoutEffect(() => {
    if (!present || overlay) return;
    if (progress.get() === 0) panelWidth.set(width);
  }, [width, overlay, present, progress, panelWidth]);
  useEffect(() => {
    const covered = overlay && panelTransition()?.hasAcceptedCover(present ? 'panel' : 'chat') === true;
    const options = {
      duration: covered || reduced ? 0 : present ? 0.38 : 0.28,
      ease: [0.32, 0.72, 0, 1] as const,
    };
    const space = animate(reservation, present && !overlay ? width + gap : 0, options);
    const size = animate(panelWidth, width, options);
    const visibility = animate(progress, present ? 1 : 0, {
      ...options, duration: covered ? 0 : reduced ? 0.1 : options.duration,
    });
    let active = true;
    void Promise.all([space, size, visibility]).then(() => {
      if (active && !present) remove?.();
      if (active && present) presented.current?.();
    });
    return () => { active = false; space.stop(); size.stop(); visibility.stop(); };
  }, [present, overlay, width, gap, reduced, reservation, panelWidth, progress, remove]);
  useEffect(() => {
    const query = matchMedia(queryText);
    setOverlay(query.matches);
    const change = () => setOverlay(query.matches);
    query.addEventListener('change', change);
    return () => query.removeEventListener('change', change);
  }, [queryText]);
  useEffect(() => {
    const element = dialog.current;
    if (!element) return;
    const focused = document.activeElement instanceof HTMLElement ? document.activeElement : null;
    const children = Array.from(element.querySelectorAll<HTMLDialogElement>('dialog[open]'));
    for (const child of [...children].reverse()) child.close();
    if (element.open) element.close();
    element.toggleAttribute('autofocus', overlay);
    if (overlay) element.showModal();
    else element.show();
    for (const child of children) child.showModal();
    if (focused && element.contains(focused)) focused.focus({ preventScroll: true });
    else if (overlay) element.focus({ preventScroll: true });
    const overflow = document.body.style.overflow;
    if (overlay) document.body.style.overflow = 'hidden';
    return () => { if (overlay) document.body.style.overflow = overflow; };
  }, [overlay]);
  useLayoutEffect(() => {
    const element = dialog.current;
    const trigger = document.activeElement instanceof HTMLElement ? document.activeElement : null;
    return () => {
      element?.close();
      element?.parentElement?.style.removeProperty('--inspector-space');
      trigger?.focus({ preventScroll: true });
    };
  }, []);
  const swipe = useSwipeDismiss({ progress, direction: 'right', enabled: overlay && present && !reduced, onDismiss: onClose });
  const content = (
    <Motion.aside
      {...swipe}
      className={`inspector-shell ${computer ? 'computer-inspector' : ''}`}
      style={{
        opacity: progress,
        x: reduced ? '0%' : translation,
        width: overlay ? undefined : panelWidth,
      }}
    >
      {children}
    </Motion.aside>
  );
  return (
    <dialog
      ref={dialog}
      closedby="closerequest"
      className="inspector-dialog"
      data-inline={!overlay || undefined}
      aria-label="어시스턴트 상세 패널"
      onKeyDown={(e) => {
        if (overlay || 'closedBy' in e.currentTarget || e.key !== 'Escape' ||
          e.defaultPrevented || e.nativeEvent.isComposing || e.repeat) return;
        const target = e.target;
        if (!(target instanceof Element) || target.closest('dialog') !== e.currentTarget ||
          target.closest('select, input[list], [role="combobox"]')) return;
        e.preventDefault();
        e.stopPropagation();
        onClose();
      }}
      onCancel={(e) => {
        if (e.target !== e.currentTarget || e.defaultPrevented) return;
        e.preventDefault();
        onClose();
      }}
      onClick={(e) => {
        if (e.target === e.currentTarget) onClose();
      }}
    >
      {content}
    </dialog>
  );
}
