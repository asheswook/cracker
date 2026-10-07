import { animate, useMotionValue } from 'motion/react';
import { useEffect, useRef, useState } from 'react';

const RAIL = 96;
const MAX_PULL = 112;
const SLOP = 10;
const DIRECTION_RATIO = 1.4;
const RESISTANCE = 0.15;
const HOLD_DELAY = 350;
const TOUCH_SPRING = { type: 'spring', stiffness: 520, damping: 32, mass: 0.6 } as const;
const NATIVE_TARGET =
  'a, button, input, textarea, select, [contenteditable], [role="button"], pre, .markdown-code, .markdown-table-scroll, video, canvas';

type Tracking = {
  readonly identifier: number;
  readonly startX: number;
  readonly startY: number;
  readonly startedAt: number;
  readonly initialPull: number;
  locked: boolean;
  lastAt: number;
  lastPull: number;
  velocity: number;
};

export function useMessageTimeReveal(reduced: boolean | null, conversationId: string | undefined) {
  const ref = useRef<HTMLDivElement>(null);
  const pull = useMotionValue(0);
  const [pinned, setPinned] = useState(false);

  useEffect(() => {
    const node = ref.current;
    if (!node) return;
    const visible = new Set<HTMLElement>();
    const paint = (row: HTMLElement, value: number) => {
      row.style.setProperty('--message-time-offset', `${-Math.max(0, value)}px`);
      row.style.setProperty('--message-time-opacity', String(Math.max(0, Math.min(1, (value - RAIL * 0.65) / (RAIL * 0.35)))));
    };
    // Inherited variables on the column invalidated every historical Markdown subtree per frame.
    // Prewarm nearby rows; scrolling and newly arriving rows adopt the current pull before entering view.
    const observer = new IntersectionObserver((entries) => {
      for (const entry of entries) {
        if (!(entry.target instanceof HTMLElement)) continue;
        if (entry.isIntersecting) {
          visible.add(entry.target);
          paint(entry.target, pull.get());
        } else {
          visible.delete(entry.target);
          entry.target.style.removeProperty('--message-time-offset');
          entry.target.style.removeProperty('--message-time-opacity');
        }
      }
    }, { rootMargin: '200px 0px' });
    const observe = (row: Node) => {
      if (row instanceof HTMLElement && row.matches('.message')) observer.observe(row);
    };
    node.childNodes.forEach(observe);
    const mutations = new MutationObserver((records) => {
      for (const record of records) {
        record.addedNodes.forEach(observe);
        for (const row of record.removedNodes) {
          if (row instanceof HTMLElement) { observer.unobserve(row); visible.delete(row); }
        }
      }
    });
    mutations.observe(node, { childList: true });
    const unsubscribe = pull.on('change', (value) => {
      for (const row of visible) paint(row, value);
    });
    return () => {
      unsubscribe();
      mutations.disconnect();
      observer.disconnect();
    };
  }, [pull]);

  useEffect(() => {
    setPinned(false);
    pull.jump(0);
  }, [conversationId, pull]);

  useEffect(() => {
    const node = ref.current;
    if (!node) return;
    let tracking: Tracking | undefined;
    let animation: ReturnType<typeof animate> | undefined;
    const selected = () => Boolean(window.getSelection()?.toString());
    const settle = (velocity = 0) => {
      animation?.stop();
      const target = pinned ? RAIL : 0;
      if (reduced) pull.jump(target);
      else animation = animate(pull, target, { ...TOUCH_SPRING, velocity });
    };
    const cancel = () => {
      tracking = undefined;
      settle();
    };
    const start = (event: TouchEvent) => {
      if (event.touches.length !== 1 || selected()) return cancel();
      const target = event.target;
      if (!(target instanceof Element) || target.closest(NATIVE_TARGET)) return;
      for (
        let element: Element | null = target;
        element && element !== node;
        element = element.parentElement
      ) {
        if (
          element.scrollWidth > element.clientWidth &&
          /auto|scroll/.test(getComputedStyle(element).overflowX)
        )
          return;
      }
      const touch = event.touches[0];
      if (!touch) return;
      animation?.stop();
      const visiblePull = Math.max(0, Math.min(MAX_PULL, pull.get()));
      tracking = {
        identifier: touch.identifier,
        startX: touch.clientX,
        startY: touch.clientY,
        startedAt: event.timeStamp,
        initialPull: visiblePull <= RAIL ? visiblePull : RAIL + (visiblePull - RAIL) / RESISTANCE,
        locked: false,
        lastAt: event.timeStamp,
        lastPull: visiblePull,
        velocity: 0,
      };
    };
    const move = (event: TouchEvent) => {
      if (!tracking) return;
      if (event.touches.length !== 1 || selected()) return cancel();
      const touch = Array.from(event.touches).find((item) => item.identifier === tracking?.identifier);
      if (!touch) return cancel();
      const dx = touch.clientX - tracking.startX;
      const dy = touch.clientY - tracking.startY;
      if (!tracking.locked) {
        if (event.timeStamp - tracking.startedAt > HOLD_DELAY) return cancel();
        if (Math.max(Math.abs(dx), Math.abs(dy)) < SLOP) return;
        if ((dx >= 0 && tracking.initialPull === 0) || Math.abs(dx) <= Math.abs(dy) * DIRECTION_RATIO) return cancel();
        tracking.locked = true;
      }
      if (!event.cancelable) return cancel();
      event.preventDefault();
      const distance = Math.max(0, tracking.initialPull - dx);
      const next = Math.min(MAX_PULL, distance <= RAIL ? distance : RAIL + (distance - RAIL) * RESISTANCE);
      const elapsed = event.timeStamp - tracking.lastAt;
      if (elapsed > 0)
        tracking.velocity = Math.max(-1500, Math.min(1500, ((next - tracking.lastPull) * 1000) / elapsed));
      tracking.lastPull = next;
      tracking.lastAt = event.timeStamp;
      pull.set(next);
    };
    const end = (event: TouchEvent) => {
      const velocity = tracking?.locked && event.timeStamp - tracking.lastAt < 80 ? tracking.velocity : 0;
      tracking = undefined;
      settle(velocity);
    };
    const visibility = () => {
      if (document.hidden) cancel();
    };
    settle();
    node.addEventListener('touchstart', start, { passive: true });
    node.addEventListener('touchmove', move, { passive: false });
    node.addEventListener('touchend', end);
    node.addEventListener('touchcancel', cancel);
    node.addEventListener('pointercancel', cancel);
    window.addEventListener('blur', cancel);
    document.addEventListener('visibilitychange', visibility);
    return () => {
      animation?.stop();
      node.removeEventListener('touchstart', start);
      node.removeEventListener('touchmove', move);
      node.removeEventListener('touchend', end);
      node.removeEventListener('touchcancel', cancel);
      node.removeEventListener('pointercancel', cancel);
      window.removeEventListener('blur', cancel);
      document.removeEventListener('visibilitychange', visibility);
    };
  }, [pinned, pull, reduced, conversationId]);

  return {
    ref,
    pinned,
    toggle: () => setPinned((value) => !value),
    close: () => setPinned(false),
  };
}
