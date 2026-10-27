import { mkdtemp, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, expect, test } from 'bun:test';
const originalInputEvent = globalThis.InputEvent;
class FieldInputEvent extends Event {
  data: string | null;
  inputType: string;
  isComposing: boolean;
  constructor(type: string, options: InputEventInit = {}) {
    super(type, { cancelable: true });
    this.data = options.data ?? null;
    this.inputType = options.inputType ?? '';
    this.isComposing = options.isComposing ?? false;
  }
}
Object.assign(globalThis, { InputEvent: FieldInputEvent });
// Execute the real hook body with deterministic hook slots and an EventTarget field, without a browser/network.
const slots: { current: unknown }[] = [];
let cursor = 0;
let effects: (() => void | (() => void))[] = [];
Object.assign(globalThis, { __screenKeyboardHooks: {
  useRef(value: unknown) { const index = cursor++; return slots[index] ?? (slots[index] = { current: value }); },
  useCallback<T>(value: T) { return value; },
  useEffect(effect: () => void | (() => void)) { effects.push(effect); },
} });
const build = await Bun.build({ entrypoints: ['apps/web/src/useComputerKeyboard.ts'], target: 'bun',
  plugins: [{ name: 'deterministic-hook-slots', setup(builder) {
    builder.onResolve({ filter: /^react$/ }, () => ({ path: 'react', namespace: 'hook-slots' }));
    builder.onLoad({ filter: /.*/, namespace: 'hook-slots' }, () => ({ loader: 'js', contents: 'export const {useRef,useCallback,useEffect}=globalThis.__screenKeyboardHooks;' }));
  } }],
});
if (!build.success || !build.outputs[0]) throw new Error('hook fixture build failed');
const directory = await mkdtemp(join(tmpdir(), 'screen-keyboard-hook-'));
const modulePath = join(directory, 'hook.mjs');
await writeFile(modulePath, await build.outputs[0].text());
const module = await import(modulePath);
afterAll(async () => {
  await rm(directory, { recursive: true, force: true });
  Reflect.deleteProperty(globalThis, '__screenKeyboardHooks');
  if (originalInputEvent) Object.assign(globalThis, { InputEvent: originalInputEvent });
  else Reflect.deleteProperty(globalThis, 'InputEvent');
});
class Field extends EventTarget {
  value = ''; selectionStart = 0; selectionEnd = 0;
  setSelectionRange(start: number, end: number) { this.selectionStart = start; this.selectionEnd = end; }
  composition(type: string, data = '') { this.dispatchEvent(Object.assign(new Event(type), { data })); }
  input(data: string | null, inputType = 'insertText', isComposing = false) {
    this.dispatchEvent(new FieldInputEvent('input', { data, inputType, isComposing }));
  }
}
function mountKeyboard() {
  slots.length = 0; cursor = 0; effects = [];
  const sent: { type: string; text?: string; key?: string; action?: string }[] = [];
  const field = new Field();
  const keyboard = module.useComputerKeyboard(true, (message: typeof sent[number]) => sent.push(message));
  keyboard.field.current = field;
  const cleanups = effects.map(effect => effect());
  return { field, sent, keyboard, cleanup: () => { for (const cleanup of cleanups) cleanup?.(); } };
}
test('actual keyboard hook discards pending composition across rapid revoke/re-enable; new composition still sends once', async () => {
  const sent: unknown[] = []; const field = new Field(); const send = (value: unknown) => sent.push(value);
  cursor = 0; effects = [];
  const first = module.useComputerKeyboard(true, send); first.field.current = field;
  const cleanups = effects.map(effect => effect());
  field.composition('compositionstart'); field.composition('compositionend', 'old pending text');
  first.discard(); for (const cleanup of cleanups) cleanup?.();
  cursor = 0; effects = [];
  module.useComputerKeyboard(true, send); const nextCleanups = effects.map(effect => effect());
  field.composition('compositionend', 'late old composition');
  await Bun.sleep(85); expect(sent).toEqual([]);
  field.composition('compositionstart'); field.composition('compositionend', 'fresh text');
  await Bun.sleep(85); expect(sent).toEqual([{ type: 'text', text: 'fresh text' }]);
  for (const cleanup of nextCleanups) cleanup?.();
});

for (const browser of ['Chrome', 'Safari']) {
  test(`${browser}: consecutive Korean syllables preserve the IME field and send only 한글`, async () => {
    const { field, sent, cleanup } = mountKeyboard();
    const texts = () => sent.filter(message => message.type === 'text').map(message => message.text).join('');
    const update = (prefix: string, data: string, isComposing: boolean) => {
      field.value = `\u200b${prefix}${data}`;
      field.composition('compositionupdate', data);
      // Some IMEs report ordinary insertText jamo even during an active composition.
      field.input(data, isComposing ? 'insertCompositionText' : 'insertText', isComposing);
    };
    const end = (data: string) => {
      field.composition('compositionend', data);
      if (browser === 'Safari') field.input(data, 'insertCompositionText', false);
    };
    try {
      field.composition('compositionstart');
      update('', 'ㅎ', true); update('', '하', false); update('', '한', true);
      end('한');
      // A synchronous reset here aborts the next syllable in macOS/WebKit IMEs.
      expect(field.value).toBe('\u200b한');
      field.composition('compositionstart');
      await Promise.resolve();
      expect(field.value).toBe('\u200b한');
      update('한', 'ㄱ', false); update('한', '그', true);
      await Bun.sleep(85);
      expect(texts()).toBe('한'); // The 60ms flush must not send unfinished 그/ㄱ.
      expect(field.value).toBe('\u200b한그');
      update('한', '글', false);
      end('글');
      await Bun.sleep(85);
      expect(texts()).toBe('한글');
      expect(field.value).toBe('\u200b');
    } finally { cleanup(); }
  });
}

test('composition field diff, duplicate final input, English, paste and editing keys remain correct', async () => {
  const { field, sent, cleanup } = mountKeyboard();
  try {
    field.composition('compositionstart');
    field.value = '\u200b한';
    field.composition('compositionend', ''); // Fallback for missing compositionend data.
    field.input('한', 'insertFromComposition');
    // A non-composition input can arrive before the deferred reset as well.
    field.value = '\u200b한a'; field.input('a');
    field.value = '\u200b한ab'; field.input('b');
    await Promise.resolve();
    field.value = '\u200bpasted 한글'; field.input(null, 'insertFromPaste');
    field.dispatchEvent(new FieldInputEvent('beforeinput', { inputType: 'deleteContentBackward' }));
    field.dispatchEvent(Object.assign(new Event('keydown', { cancelable: true }), {
      key: 'Enter', isComposing: false, keyCode: 13,
    }));
    expect(sent).toEqual([
      { type: 'text', text: '한abpasted 한글' },
      { type: 'key', key: 'BackSpace', action: 'down' },
      { type: 'key', key: 'BackSpace', action: 'up' },
      { type: 'key', key: 'Enter', action: 'down' },
      { type: 'key', key: 'Enter', action: 'up' },
    ]);
  } finally { cleanup(); }
});
