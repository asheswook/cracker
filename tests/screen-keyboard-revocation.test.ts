import { mkdtemp, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, expect, test } from 'bun:test';
import { Input } from '../packages/screen/protocol';
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
  useMemo<T>(factory: () => T) { return factory(); },
  useEffect(effect: () => void | (() => void)) { effects.push(effect); },
} });
const build = await Bun.build({ entrypoints: ['apps/web/src/useComputerKeyboard.ts', 'apps/web/src/useComputerInput.ts'], target: 'bun',
  plugins: [{ name: 'deterministic-hook-slots', setup(builder) {
    builder.onResolve({ filter: /^react$/ }, () => ({ path: 'react', namespace: 'hook-slots' }));
    builder.onLoad({ filter: /.*/, namespace: 'hook-slots' }, () => ({ loader: 'js', contents: 'export const {useRef,useCallback,useMemo,useEffect}=globalThis.__screenKeyboardHooks;' }));
  } }],
});
if (!build.success || build.outputs.length !== 2) throw new Error('hook fixture build failed');
const directory = await mkdtemp(join(tmpdir(), 'screen-keyboard-hook-'));
const modulePath = join(directory, 'hook.mjs');
const inputModulePath = join(directory, 'input.mjs');
await writeFile(modulePath, await build.outputs.find(output => output.path.endsWith('/useComputerKeyboard.js'))!.text());
await writeFile(inputModulePath, await build.outputs.find(output => output.path.endsWith('/useComputerInput.js'))!.text());
const module = await import(modulePath);
const inputModule = await import(inputModulePath);
afterAll(async () => {
  await rm(directory, { recursive: true, force: true });
  Reflect.deleteProperty(globalThis, '__screenKeyboardHooks');
  if (originalInputEvent) Object.assign(globalThis, { InputEvent: originalInputEvent });
  else Reflect.deleteProperty(globalThis, 'InputEvent');
});
class Field extends EventTarget {
  value = ''; selectionStart = 0; selectionEnd = 0;
  focused = false;
  focus() { this.focused = true; }
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

test('desktop video IME keydowns never send jamo; textarea sends the completed syllable', async () => {
  const { field, sent, keyboard, cleanup } = mountKeyboard();
  // The input hook's window/wheel effect is not needed for keyboard handlers.
  const input = inputModule.useComputerInput({ current: null }, true, (message: typeof sent[number]) => sent.push(message), 'direct', {
    field: keyboard.field, flush: keyboard.flush,
  });
  const keyEvent = (key: string, keyCode: number, currentTarget: unknown = {}, extras = {}) => ({
    key, code: '', currentTarget, ctrlKey: false, altKey: false, metaKey: false,
    defaultPrevented: false, nativeEvent: { isComposing: false, keyCode },
    preventDefault() { this.defaultPrevented = true; }, ...extras,
  });
  try {
    for (const [key, keyCode] of [['Process', 229], ['ㅎ', 229], ['ㅏ', 65], ['ㄴ', 78], ['한', 0]] as const) {
      input.keyboard(keyEvent(key, keyCode), 'down');
      input.keyboard(keyEvent(key, keyCode), 'up');
    }
    expect(field.focused).toBe(true);
    expect(sent).toEqual([]);
    field.composition('compositionstart');
    for (const data of ['ㅎ', '하', '한']) {
      field.value = `\u200b${data}`;
      input.keyboard(keyEvent('Process', 229, field), 'down');
      field.input(data, 'insertCompositionText', true);
    }
    await Bun.sleep(85);
    expect(sent).toEqual([]);
    field.composition('compositionend', '한');
    field.input('한', 'insertCompositionText', false);
    await Bun.sleep(85);
    expect(sent).toEqual([{ type: 'text', text: '한' }]);
    // Plain ASCII also belongs to input events, not the old video keydown path.
    input.keyboard(keyEvent('a', 65), 'down');
    expect(sent).toEqual([{ type: 'text', text: '한' }]);
    field.value = '\u200ba'; field.input('a');
    // Shortcuts/function keys still use paired remote key events and flush text first.
    for (const key of ['Control', 'c', 'v', 'a', 'F5']) {
      input.keyboard(keyEvent(key, 0, field, { ctrlKey: true }), 'down');
      input.keyboard(keyEvent(key, 0, field, { ctrlKey: true }), 'up');
    }
    expect(sent.slice(0, 2)).toEqual([{ type: 'text', text: '한' }, { type: 'text', text: 'a' }]);
    expect(sent.slice(2)).toEqual(['Control_L', 'c', 'v', 'a', 'F5'].flatMap(key => [
      { type: 'key', key, action: 'down' }, { type: 'key', key, action: 'up' },
    ]));
    for (const message of sent) expect(Input.parse(message) as unknown).toEqual(message);
    // Native textarea keydown already handles editing keys; React must not duplicate them.
    const event = Object.assign(new Event('keydown', { cancelable: true }), {
      key: 'Backspace', isComposing: false, keyCode: 8,
    });
    field.dispatchEvent(event);
    input.keyboard(keyEvent('Backspace', 8, field, { defaultPrevented: event.defaultPrevented }), 'down');
    input.keyboard(keyEvent('Backspace', 8, field), 'up');
    expect(sent.slice(-2)).toEqual([
      { type: 'key', key: 'BackSpace', action: 'down' }, { type: 'key', key: 'BackSpace', action: 'up' },
    ]);
    expect(sent).toHaveLength(14);
  } finally { cleanup(); }
});
