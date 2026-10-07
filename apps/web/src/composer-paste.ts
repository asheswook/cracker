export const PASTE_TEXT_CHARACTERS = 4000;
export const PASTE_TEXT_LINES = 80;
export function plainPaste(text: string) { return text.replace(/\r\n?/g, '\n'); }
export function pasteNeedsAttachment(text: string) {
  return text.length >= PASTE_TEXT_CHARACTERS || text.split('\n').length >= PASTE_TEXT_LINES;
}
