import { expect, test } from 'bun:test';
import {
  artifactKind, canOpenInline, csvPreview, parseCsv, readCapped, textPreview,
} from '../apps/web/src/artifact-preview';

test('parseCsv handles quotes, escaped quotes, embedded commas/newlines, CRLF and BOM', () => {
  const text = '\uFEFF이름,메모,금액\r\n"김, 철수","그가 ""안녕""\n이라고 함",1200\r\n박영희,,30\n\n';
  expect(parseCsv(text).rows).toEqual([
    ['이름', '메모', '금액'],
    ['김, 철수', '그가 "안녕"\n이라고 함', '1200'],
    ['박영희', '', '30'],
  ]);
  expect(parseCsv('a,b\n1,2').rows).toEqual([['a', 'b'], ['1', '2']]);
  expect(parseCsv('a,b\r1,2\r').rows).toEqual([['a', 'b'], ['1', '2']]);
});

test('parseCsv drops the cut-off last record when partial and stops at maxRows', () => {
  expect(parseCsv('a,b\n1,2\n3,"unfinish', { partial: true }).rows).toEqual([['a', 'b'], ['1', '2']]);
  const limited = parseCsv('h\n1\n2\n3\n', { maxRows: 2 });
  expect(limited.rows).toEqual([['h'], ['1']]);
  expect(limited.truncated).toBe(true);
  expect(parseCsv('h\n1\n', { maxRows: 2 }).truncated).toBe(false);
});

test('csvPreview caps rows and columns and reports totals', () => {
  const header = 'c1,c2,c3,c4,c5,c6,c7';
  const rows = Array.from({ length: 12 }, (_, i) => Array.from({ length: 7 }, (_, j) => `${i}-${j}`).join(','));
  const preview = csvPreview([header, ...rows].join('\n'));
  expect(preview.header).toEqual(['c1', 'c2', 'c3', 'c4', 'c5']);
  expect(preview.body).toHaveLength(5);
  expect(preview.body[0]).toEqual(['0-0', '0-1', '0-2', '0-3', '0-4']);
  expect(preview.rowCount).toBe(12);
  expect(preview.columnCount).toBe(7);
  // Ragged rows are padded.
  expect(csvPreview('a,b,c\n1').body).toEqual([['1', '', '']]);
});

test('textPreview keeps the first lines and flags more', () => {
  expect(textPreview('\n\n1\n2\n3', 6)).toEqual({ text: '1\n2\n3', more: false });
  const long = textPreview(Array.from({ length: 10 }, (_, i) => `line ${i}`).join('\r\n'));
  expect(long.text.split('\n')).toHaveLength(6);
  expect(long.more).toBe(true);
});

test('kinds for real artifact types: what opens in the viewer and what downloads', () => {
  const docx = 'application/vnd.openxmlformats-officedocument.wordprocessingml.document';
  expect(artifactKind('text/csv', 'a.csv')).toBe('csv');
  expect(artifactKind(docx, 'r.docx')).toBe('docx');
  expect(artifactKind('application/zip', 'a.zip')).toBe('zip');
  expect(artifactKind('text/markdown', 'a.md')).toBe('markdown');
  expect(artifactKind('application/octet-stream', 'data.csv')).toBe('csv');
  expect(artifactKind('image/png', 'a.png')).toBe('image');
  expect(canOpenInline('zip')).toBe(false);
  expect(canOpenInline('docx')).toBe(false);
  expect(canOpenInline('pdf')).toBe(true);
});

test('readCapped decodes UTF-8 without splitting a character at the cap', async () => {
  const bytes = new TextEncoder().encode('가나다라');
  const full = await readCapped(new Response(bytes), 1024);
  expect(full).toEqual({ text: '가나다라', complete: true });
  const cut = await readCapped(new Response(bytes), 7); // 2 full chars + 1 byte of the third
  expect(cut).toEqual({ text: '가나', complete: false });
});
