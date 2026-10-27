type KeyEvent = {
  code: string;
  key: string;
  isComposing?: boolean;
  keyCode?: number;
  nativeEvent?: { isComposing?: boolean; keyCode?: number };
};
const characters: Readonly<Record<string, string>> = {
  ' ': 'space', '!': 'exclam', '"': 'quotedbl', '#': 'numbersign', '$': 'dollar',
  '%': 'percent', '&': 'ampersand', "'": 'apostrophe', '(': 'parenleft', ')': 'parenright',
  '*': 'asterisk', '+': 'plus', ',': 'comma', '-': 'minus', '.': 'period', '/': 'slash',
  ':': 'colon', ';': 'semicolon', '<': 'less', '=': 'equal', '>': 'greater', '?': 'question',
  '@': 'at', '[': 'bracketleft', '\\': 'backslash', ']': 'bracketright', '^': 'asciicircum',
  '_': 'underscore', '`': 'grave', '{': 'braceleft', '|': 'bar', '}': 'braceright', '~': 'asciitilde',
  '¥': 'yen',
};
const codes: Readonly<Record<string, string>> = {
  Enter: 'Enter', Tab: 'Tab', Escape: 'Escape', Backspace: 'BackSpace', Delete: 'Delete',
  ArrowLeft: 'Left', ArrowRight: 'Right', ArrowUp: 'Up', ArrowDown: 'Down',
  Home: 'Home', End: 'End', PageUp: 'Page_Up', PageDown: 'Page_Down',
  Minus: 'minus', Equal: 'equal', BracketLeft: 'bracketleft', BracketRight: 'bracketright',
  Backslash: 'backslash', Semicolon: 'semicolon', Quote: 'apostrophe',
  Comma: 'comma', Period: 'period', Slash: 'slash', Backquote: 'grave',
  ControlLeft: 'Control_L', ControlRight: 'Control_L', ShiftLeft: 'Shift_L', ShiftRight: 'Shift_L',
  AltLeft: 'Alt_L', AltRight: 'ISO_Level3_Shift', MetaLeft: 'Super_L', MetaRight: 'Super_L',
  Lang1: 'Hangul', HangulMode: 'Hangul', Lang2: 'Hangul_Hanja', HanjaMode: 'Hangul_Hanja',
  NumpadAdd: 'KP_Add', NumpadSubtract: 'KP_Subtract', NumpadMultiply: 'KP_Multiply',
  NumpadDivide: 'KP_Divide', NumpadDecimal: 'KP_Decimal', NumpadEnter: 'KP_Enter',
};
function macPlatform() {
  if (typeof navigator === 'undefined') return false;
  const data = navigator as Navigator & { userAgentData?: { platform?: string } };
  return /Mac/i.test(`${navigator.platform} ${data.userAgentData?.platform ?? ''}`);
}
export function remoteKeysym(event: KeyEvent): string | undefined {
  const { code, key } = event;
  if (code === 'CapsLock') return macPlatform() ? 'Hangul' : 'Caps_Lock';
  if (/^Numpad[0-9]$/.test(code)) return `KP_${code.slice(6)}`;
  // Modifiers, editing keys and the keypad have fixed meanings across layouts.
  if (codes[code] && !/^(Minus|Equal|BracketLeft|BracketRight|Backslash|Semicolon|Quote|Comma|Period|Slash|Backquote)$/.test(code)) return codes[code];
  if (/^F(?:[1-9]|1[0-9]|2[0-4])$/.test(code)) return code;
  const ime = event.isComposing || event.nativeEvent?.isComposing || event.keyCode === 229 ||
    event.nativeEvent?.keyCode === 229 || key === 'Process' || /[\u1100-\u11ff\u3130-\u318f\ua960-\ua97f\uac00-\ud7ff]/.test(key);
  if (ime) {
    if (/^Key[A-Z]$/.test(code)) return code.slice(3).toLowerCase();
    if (/^Digit[0-9]$/.test(code)) return code.slice(5);
    if (code === 'Space') return 'space';
  }
  if (key?.length === 1) {
    if (/^[a-z0-9]$/i.test(key)) return key;
    if (characters[key]) return characters[key];
  }
  return codes[code];
}

export function forwardHardwareKey(event: KeyEvent & { ctrlKey: boolean; altKey: boolean; metaKey: boolean }) {
  if (!event.code || event.code === 'Unidentified') return false;
  // Text (including local IME composition) stays in the soft-keyboard field.
  return event.ctrlKey || event.altKey || event.metaKey ||
    (Boolean(remoteKeysym(event)) && !event.isComposing && !event.nativeEvent?.isComposing &&
      event.keyCode !== 229 && event.nativeEvent?.keyCode !== 229 &&
      event.key.length !== 1 && event.key !== 'Process' && event.key !== 'Dead');
}
