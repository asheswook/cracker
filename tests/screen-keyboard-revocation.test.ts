import { mkdtemp, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, expect, test } from 'bun:test';
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
afterAll(async () => { await rm(directory, { recursive: true, force: true }); Reflect.deleteProperty(globalThis, '__screenKeyboardHooks'); });
class Field extends EventTarget {
  value = ''; selectionStart = 0; selectionEnd = 0;
  setSelectionRange(start: number, end: number) { this.selectionStart = start; this.selectionEnd = end; }
  composition(type: string, data = '') { this.dispatchEvent(Object.assign(new Event(type), { data })); }
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
