import { describe, expect, test } from 'bun:test';
import { pasteNeedsAttachment, plainPaste } from '../apps/web/src/composer-paste';

describe('composer paste file boundary', () => {
  test('short ordinary text and a 3999-character paste remain text', () => {
    expect(pasteNeedsAttachment('Hello\nworld')).toBe(false);
    expect(pasteNeedsAttachment('a'.repeat(3999))).toBe(false);
  });
  test('4000 UTF16 units and 80 lines become attachments', () => {
    expect(pasteNeedsAttachment('a'.repeat(4000))).toBe(true);
    expect(pasteNeedsAttachment('🙂'.repeat(2000))).toBe(true);
    expect(pasteNeedsAttachment('🙂'.repeat(1999))).toBe(false);
    expect(pasteNeedsAttachment(Array(79).fill('line').join('\n'))).toBe(false);
    expect(pasteNeedsAttachment(Array(80).fill('line').join('\n'))).toBe(true);
  });
  test('normalization keeps meaningful Markdown, code, spaces, Unicode and blank lines', () => {
    expect(plainPaste('  # heading\r\n\r\n```ts\rconst x = "한🙂";  \r\n```\r\n'))
      .toBe('  # heading\n\n```ts\nconst x = "한🙂";  \n```\n');
  });
});
