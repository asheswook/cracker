import { useRef } from 'react';
import type { PointerEvent as ReactPointerEvent } from 'react';
import { animate, type MotionValue } from 'motion/react';

type Direction = 'right' | 'left';
const startSlop = 10;
const flingVelocity = 0.5;
const ease = [0.32, 0.72, 0, 1] as const;

function scrollsHorizontally(target: EventTarget | null, stop: Element): boolean {
  for (let node = target instanceof Element ? target : null; node && node !== stop; node = node.parentElement) {
    if (node.scrollWidth > node.clientWidth + 1 && /(auto|scroll)/.test(getComputedStyle(node).overflowX)) return true;
    if (node.matches('input, textarea, select, [contenteditable="true"], canvas, video, .computer-screen')) return true;
  }
  return false;
}

export function useSwipeDismiss({ progress, direction, enabled, onDismiss, onTracking }: {
  readonly progress: MotionValue<number>;
  readonly direction: Direction;
  readonly enabled: boolean;
  readonly onDismiss: () => void;
  readonly onTracking?: (tracking: boolean) => void;
}) {
  const gesture = useRef<{ id: number; x: number; y: number; width: number; tracking: boolean; lastX: number; lastT: number; velocity: number } | null>(null);
  const sign = direction === 'right' ? 1 : -1;
  const onPointerDown = (event: ReactPointerEvent<HTMLElement>) => {
    if (!enabled || event.pointerType === 'mouse' || !event.isPrimary) return;
    if (scrollsHorizontally(event.target, event.currentTarget)) return;
    gesture.current = { id: event.pointerId, x: event.clientX, y: event.clientY, width: event.currentTarget.getBoundingClientRect().width || 1, tracking: false, lastX: event.clientX, lastT: event.timeStamp, velocity: 0 };
  };
  const onPointerMove = (event: ReactPointerEvent<HTMLElement>) => {
    const current = gesture.current;
    if (!current || current.id !== event.pointerId) return;
    const dx = (event.clientX - current.x) * sign, dy = event.clientY - current.y;
    if (!current.tracking) {
      if (Math.abs(dy) > startSlop && Math.abs(dy) > Math.abs(dx)) { gesture.current = null; return; }
      if (dx < startSlop) return;
      current.tracking = true;
      onTracking?.(true);
      event.currentTarget.setPointerCapture(event.pointerId);
    }
    const elapsed = Math.max(1, event.timeStamp - current.lastT);
    current.velocity = ((event.clientX - current.lastX) * sign) / elapsed;
    current.lastX = event.clientX; current.lastT = event.timeStamp;
    progress.set(Math.min(1, Math.max(0, 1 - Math.max(0, dx) / current.width)));
  };
  const finish = (event: ReactPointerEvent<HTMLElement>, cancelled: boolean) => {
    const current = gesture.current;
    if (!current || current.id !== event.pointerId) return;
    gesture.current = null;
    if (!current.tracking) return;
    onTracking?.(false);
    const dismiss = !cancelled && (current.velocity > flingVelocity || progress.get() < 0.6);
    if (dismiss) onDismiss();
    else void animate(progress, 1, { duration: 0.32, ease });
  };
  return {
    onPointerDown,
    onPointerMove,
    onPointerUp: (event: ReactPointerEvent<HTMLElement>) => finish(event, false),
    onPointerCancel: (event: ReactPointerEvent<HTMLElement>) => finish(event, true),
  };
}
