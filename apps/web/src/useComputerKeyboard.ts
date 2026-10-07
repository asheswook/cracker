import { useCallback, useEffect, useRef } from 'react';
import { splitComputerText } from './computerText';

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
      lastComposition = '';
    };
    const end = (event: CompositionEvent) => {
      if (!composing.current) { reset(); return; }
      composing.current = false;
      lastComposition = event.data;
      commit(event.data);
      reset();
    };
    const input = (event: Event) => {
      if (!(event instanceof InputEvent) || composing.current || event.isComposing) return;
      if (
        lastComposition &&
        (event.inputType === 'insertFromComposition' || event.inputType === 'insertCompositionText') &&
        event.data === lastComposition
      ) {
        lastComposition = '';
        reset();
        return;
      }
      lastComposition = '';
      const text = element.value.startsWith(anchor) ? element.value.slice(1) : element.value;
      commit(text);
      reset();
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
        reset();
      }
    };
    const keyboard = (event: KeyboardEvent) => {
      if (composing.current || event.isComposing || event.keyCode === 229) return;
      const name = editingKeys[event.key];
      if (name) {
        event.preventDefault();
        key(name);
        reset();
      }
    };
    const blur = () => {
      flush();
      composing.current = false;
      reset();
    };
    element.addEventListener('compositionstart', start);
    element.addEventListener('compositionend', end);
    element.addEventListener('beforeinput', before);
    element.addEventListener('input', input);
    element.addEventListener('keydown', keyboard);
    element.addEventListener('blur', blur);
    return () => {
      discard();
      element.removeEventListener('compositionstart', start);
      element.removeEventListener('compositionend', end);
      element.removeEventListener('beforeinput', before);
      element.removeEventListener('input', input);
      element.removeEventListener('keydown', keyboard);
      element.removeEventListener('blur', blur);
    };
  }, [enabled, send, reset, flush, key, discard]);
  const revoke = useCallback(() => { active.current = false; discard(); }, [discard]);
  return { field, flush, key, discard: revoke };
}
