import { useCallback, useEffect, useMemo, useRef } from 'react';
import type { KeyboardEvent, PointerEvent, RefObject } from 'react';
import { createComputerPointer, type ComputerPointerMode } from './computerPointer';

const keys: Readonly<Record<string, string>> = {
  Enter: 'Enter',
  Tab: 'Tab',
  Escape: 'Escape',
  Backspace: 'BackSpace',
  Delete: 'Delete',
  ArrowLeft: 'Left',
  ArrowRight: 'Right',
  ArrowUp: 'Up',
  ArrowDown: 'Down',
  Home: 'Home',
  End: 'End',
  PageUp: 'Page_Up',
  PageDown: 'Page_Down',
  Space: 'space',
  Minus: 'minus', Equal: 'equal', BracketLeft: 'bracketleft', BracketRight: 'bracketright',
  Backslash: 'backslash', Semicolon: 'semicolon', Quote: 'apostrophe',
  Comma: 'comma', Period: 'period', Slash: 'slash', Backquote: 'grave',
  ControlLeft: 'Control_L', ControlRight: 'Control_L',
  ShiftLeft: 'Shift_L', ShiftRight: 'Shift_L',
  AltLeft: 'Alt_L', AltRight: 'Alt_L',
  MetaLeft: 'Super_L', MetaRight: 'Super_L',
  CapsLock: 'Hangul', Lang1: 'Hangul', Lang2: 'Hangul', HangulMode: 'Hangul',
};

export function useComputerInput(
  video: RefObject<HTMLVideoElement | null>,
  enabled: boolean,
  send: (message: unknown) => void,
  mode: ComputerPointerMode = 'direct',
) {
  const pressedKeys = useRef(new Map<string, string>());
  const controller = useMemo(() => createComputerPointer(send), [send]);
  const captured = useRef(new Set<number>());
  const releasePointer = useCallback(() => {
    controller.release();
    for (const id of captured.current) {
      if (video.current?.hasPointerCapture(id)) video.current.releasePointerCapture(id);
    }
    captured.current.clear();
  }, [controller, video]);
  const release = useCallback(() => {
    for (const key of pressedKeys.current.values()) send({ type: 'key', key, action: 'up' });
    pressedKeys.current.clear();
    releasePointer();
  }, [send, releasePointer]);
  useEffect(() => {
    const element = video.current;
    if (!enabled || !element) return;
    let wheelRemainder = 0;
    const wheel = (event: WheelEvent) => {
      event.preventDefault();
      const delta =
        event.deltaY * (event.deltaMode === 1 ? 16 : event.deltaMode === 2 ? element.clientHeight : 1);
      wheelRemainder += delta;
      const steps = Math.trunc(wheelRemainder / 40);
      if (steps) {
        wheelRemainder -= steps * 40;
        send({ type: 'scroll', dy: Math.max(-20, Math.min(20, steps)) });
      }
    };
    element.addEventListener('wheel', wheel, { passive: false });
    window.addEventListener('blur', release);
    return () => {
      release();
      element.removeEventListener('wheel', wheel);
      window.removeEventListener('blur', release);
    };
  }, [enabled, send, video, release, mode]);
  const pointer = (event: PointerEvent<HTMLVideoElement>, action: 'down' | 'up' | 'move') => {
    if (!enabled) return;
    const element = event.currentTarget;
    if (!element.videoWidth || !element.videoHeight) return;
    const rect = element.getBoundingClientRect();
    const scale = Math.min(rect.width / element.videoWidth, rect.height / element.videoHeight);
    const width = element.videoWidth * scale,
      height = element.videoHeight * scale;
    if (action === 'down') {
      event.preventDefault();
      element.focus({ preventScroll: true });
      element.setPointerCapture(event.pointerId);
      captured.current.add(event.pointerId);
    }
    controller.handle(
      {
        id: event.pointerId,
        kind: event.pointerType,
        action,
        button: event.button,
        x: event.clientX,
        y: event.clientY,
        time: event.timeStamp,
        bounds: {
          left: rect.left + (rect.width - width) / 2,
          top: rect.top + (rect.height - height) / 2,
          width,
          height,
        },
      },
      mode,
    );
    if (action === 'up') {
      captured.current.delete(event.pointerId);
      if (element.hasPointerCapture(event.pointerId)) element.releasePointerCapture(event.pointerId);
    }
  };
  const keyboard = (event: KeyboardEvent<HTMLVideoElement>, action: 'down' | 'up') => {
    if (!enabled) return;
    // Compose inside the VM: local layout, jamo and IME/229 flags are irrelevant.
    event.preventDefault();
    const physicalKey = event.code;
    if (action === 'up' && !pressedKeys.current.has(physicalKey)) return;
    const key =
      pressedKeys.current.get(physicalKey) ??
      keys[physicalKey] ??
      (/^F(?:[1-9]|1[0-9]|2[0-4])$/.test(physicalKey) ? physicalKey : null) ??
      (/^Key[A-Z]$/.test(physicalKey) ? physicalKey.slice(3).toLowerCase() : null) ??
      (/^Digit[0-9]$/.test(physicalKey) ? physicalKey.slice(5) : null);
    if (!key) return;
    if (action === 'down') pressedKeys.current.set(physicalKey, key);
    else pressedKeys.current.delete(physicalKey);
    send({ type: 'key', key, action });
  };
  return {
    pointer,
    keyboard,
    release,
    releasePointer,
    lostPointer: (id: number) => {
      if (controller.has(id) || captured.current.has(id)) releasePointer();
    },
  };
}
