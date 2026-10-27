import { useCallback, useEffect, useRef } from 'react';
import { splitComputerText } from './computerText';
import { forwardHardwareKey, remoteKeysym } from './computerKeys';

const anchor = '\u200b';
const editingKeys: Readonly<Record<string, string>> = {
  Enter: 'Enter',
  Backspace: 'BackSpace',
  Delete: 'Delete',
  Tab: 'Tab',
  Escape: 'Escape',
  ArrowLeft: 'Left',
  ArrowRight: 'Right',
  ArrowUp: 'Up',
  ArrowDown: 'Down',
};

export function useComputerKeyboard(enabled: boolean, send: (message: unknown) => void) {
  const active = useRef(enabled);
  active.current = enabled;
  const field = useRef<HTMLTextAreaElement>(null);
  const pending = useRef('');
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const composing = useRef(false);
  const reset = useCallback(() => {
    const element = field.current;
    if (element) {
      element.value = anchor;
      element.setSelectionRange(1, 1);
    }
  }, []);
  const flush = useCallback(() => {
    if (timer.current) clearTimeout(timer.current);
    timer.current = null;
    if (active.current && pending.current) send({ type: 'text', text: pending.current });
    pending.current = '';
  }, [enabled, send]);
  const key = useCallback(
    (name: string) => {
      if (!active.current) return;
      flush();
      send({ type: 'key', key: name, action: 'down' });
      send({ type: 'key', key: name, action: 'up' });
    },
    [enabled, flush, send],
  );
  const discard = useCallback(() => {
    if (timer.current) clearTimeout(timer.current);
    timer.current = null;
    pending.current = '';
    composing.current = false;
    reset();
  }, [reset]);
  useEffect(() => {
    const element = field.current;
    if (!element || !enabled) {
      discard();
      return;
    }
    reset();
    let lastComposition = '';
    let compositionPrefix = '';
    let consumedValue = '';
    let resetPending = false;
    let disposed = false;
    const held = new Map<string, string>();
    const releaseHardware = () => {
      for (const name of held.values()) send({ type: 'key', key: name, action: 'up' });
      held.clear();
    };
    const value = () => element.value.startsWith(anchor) ? element.value.slice(1) : element.value;
    const difference = (text: string, prefix: string) => text.startsWith(prefix) ? text.slice(prefix.length) : text;
    const resetField = () => {
      if (composing.current) return;
      reset();
      consumedValue = '';
      resetPending = false;
    };
    const deferReset = () => {
      resetPending = true;
      // Korean IMEs may start the next syllable immediately after compositionend.
      // Rewriting the value/selection in that gap aborts the next composition.
      queueMicrotask(() => {
        if (!disposed && active.current && resetPending) resetField();
      });
    };
    const commit = (text: string) => {
      if (!active.current || !text) return;
      const chunks = splitComputerText(pending.current + text);
      pending.current = chunks.pop() ?? '';
      for (const chunk of chunks) send({ type: 'text', text: chunk });
      if (timer.current) clearTimeout(timer.current);
      timer.current = setTimeout(flush, 60);
    };
    const start = () => {
      composing.current = true;
      compositionPrefix = value();
      lastComposition = '';
    };
    const end = (event: CompositionEvent) => {
      if (!composing.current) return;
      composing.current = false;
      const text = event.data || difference(value(), compositionPrefix);
      lastComposition = text;
      consumedValue = compositionPrefix + text;
      // Only completed text enters the 60ms batching buffer, never an IME update.
      commit(text);
      deferReset();
    };
    const input = (event: Event) => {
      if (!(event instanceof InputEvent) || composing.current || event.isComposing) return;
      if (
        lastComposition &&
        (event.inputType === 'insertFromComposition' || event.inputType === 'insertCompositionText') &&
        event.data === lastComposition
      ) {
        lastComposition = '';
        consumedValue = value();
        deferReset();
        return;
      }
      lastComposition = '';
      const text = value();
      commit(difference(text, consumedValue));
      consumedValue = text;
      deferReset();
    };
    const before = (event: InputEvent) => {
      if (composing.current || event.isComposing) return;
      const name =
        event.inputType === 'deleteContentBackward'
          ? 'BackSpace'
          : event.inputType === 'deleteContentForward'
            ? 'Delete'
            : ['insertParagraph', 'insertLineBreak'].includes(event.inputType)
              ? 'Enter'
              : null;
      if (name) {
        event.preventDefault();
        key(name);
        resetField();
      }
    };
    const keyboard = (event: KeyboardEvent) => {
      if (forwardHardwareKey(event)) {
        const name = held.get(event.code) ?? remoteKeysym(event);
        if (name) {
          event.preventDefault(); flush();
          held.set(event.code, name);
          send({ type: 'key', key: name, action: 'down' });
        }
        return;
      }
      if (composing.current || event.isComposing || event.keyCode === 229) return;
      if (event.ctrlKey || event.altKey || event.metaKey) return;
      const name = editingKeys[event.key];
      if (name) {
        event.preventDefault();
        key(name);
        resetField();
      }
    };
    const keyup = (event: KeyboardEvent) => {
      const name = held.get(event.code);
      if (!name) return;
      event.preventDefault();
      held.delete(event.code);
      send({ type: 'key', key: name, action: 'up' });
    };
    const blur = () => {
      flush();
      releaseHardware();
      composing.current = false;
      resetField();
    };
    element.addEventListener('compositionstart', start);
    element.addEventListener('compositionend', end);
    element.addEventListener('beforeinput', before);
    element.addEventListener('input', input);
    element.addEventListener('keydown', keyboard);
    element.addEventListener('keyup', keyup);
    element.addEventListener('blur', blur);
    return () => {
      disposed = true;
      releaseHardware();
      discard();
      element.removeEventListener('compositionstart', start);
      element.removeEventListener('compositionend', end);
      element.removeEventListener('beforeinput', before);
      element.removeEventListener('input', input);
      element.removeEventListener('keydown', keyboard);
      element.removeEventListener('keyup', keyup);
      element.removeEventListener('blur', blur);
    };
  }, [enabled, send, reset, flush, key, discard]);
  const revoke = useCallback(() => { active.current = false; discard(); }, [discard]);
  return { field, flush, key, discard: revoke };
}
