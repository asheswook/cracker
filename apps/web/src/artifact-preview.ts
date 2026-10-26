// Pure helpers for assistant-produced files: what kind of file it is, how big, and a small CSV/text preview.
export type ArtifactKind = 'csv' | 'markdown' | 'text' | 'image' | 'pdf' | 'docx' | 'zip' | 'other';

const raster = new Set(['image/png', 'image/jpeg', 'image/webp', 'image/gif']);

function extension(name: string): string {
  const dot = name.lastIndexOf('.');
  return dot > 0 ? name.slice(dot + 1).toLowerCase() : '';
}

export function artifactKind(mediaType: string, name: string): ArtifactKind {
  const type = mediaType.toLowerCase().split(';')[0]?.trim() ?? '';
  const ext = extension(name);
  if (type === 'text/csv' || type === 'application/csv' || ext === 'csv') return 'csv';
  if (type === 'text/markdown' || type === 'text/x-markdown' || ext === 'md' || ext === 'markdown') return 'markdown';
  if (raster.has(type)) return 'image';
  if (type === 'application/pdf' || ext === 'pdf') return 'pdf';
  if (type === 'application/vnd.openxmlformats-officedocument.wordprocessingml.document' || ext === 'docx') return 'docx';
  if (type === 'application/zip' || type === 'application/x-zip-compressed' || ext === 'zip') return 'zip';
  if (type.startsWith('text/') || ext === 'txt' || ext === 'log') return 'text';
  return 'other';
}

export function kindLabel(kind: ArtifactKind, mediaType: string, name: string): string {
  switch (kind) {
    case 'csv': return '표 · CSV';
    case 'markdown': return '문서 · Markdown';
    case 'text': return '텍스트';
    case 'pdf': return '문서 · PDF';
    case 'docx': return 'Word 문서';
    case 'zip': return '압축 파일';
    case 'image': {
      const sub = mediaType.split('/')[1]?.toUpperCase();
      return sub ? `이미지 · ${sub === 'JPEG' ? 'JPG' : sub}` : '이미지';
    }
    default: {
      const ext = extension(name);
      return ext ? `파일 · ${ext.toUpperCase()}` : '파일';
    }
  }
}

/** Kinds that 열기 shows inside the app; everything else simply downloads. */
export function canOpenInline(kind: ArtifactKind): boolean {
  return kind === 'csv' || kind === 'markdown' || kind === 'text' || kind === 'image' || kind === 'pdf';
}

/** Kinds that get a small text-based preview on the card. */
export function hasTextPreview(kind: ArtifactKind): boolean {
  return kind === 'csv' || kind === 'markdown' || kind === 'text';
}

export function formatBytes(bytes: number): string {
  if (!Number.isFinite(bytes) || bytes < 0) return '';
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${Math.max(1, Math.round(bytes / 1024))} KB`;
  const mb = bytes / (1024 * 1024);
  return `${mb < 10 ? mb.toFixed(1) : Math.round(mb)} MB`;
}

export function formatCount(value: number): string {
  return value.toLocaleString('ko-KR');
}

export interface CsvParse {
  readonly rows: string[][];
  /** True when parsing stopped at maxRows before the end of the text. */
  readonly truncated: boolean;
}

/**
 * RFC 4180-ish CSV parser: quoted fields, doubled quotes, commas/newlines inside quotes, CRLF/LF/CR, leading BOM.
 * When `partial` is set (the text was cut off mid-file), the last, possibly incomplete record is dropped.
 */
export function parseCsv(input: string, options: { maxRows?: number; partial?: boolean } = {}): CsvParse {
  const maxRows = options.maxRows ?? Number.POSITIVE_INFINITY;
  const text = input.charCodeAt(0) === 0xfeff ? input.slice(1) : input;
  const rows: string[][] = [];
  let row: string[] = [];
  let field = '';
  let quoted = false;
  let i = 0;
  const n = text.length;
  const endRow = () => {
    row.push(field);
    field = '';
    // Skip fully blank lines.
    if (!(row.length === 1 && row[0] === '')) rows.push(row);
    row = [];
  };
  while (i < n) {
    const ch = text[i]!;
    if (quoted) {
      if (ch === '"') {
        if (text[i + 1] === '"') { field += '"'; i += 2; continue; }
        quoted = false; i += 1; continue;
      }
      field += ch; i += 1; continue;
    }
    if (ch === '"' && field === '') { quoted = true; i += 1; continue; }
    if (ch === ',') { row.push(field); field = ''; i += 1; continue; }
    if (ch === '\r' || ch === '\n') {
      endRow();
      i += ch === '\r' && text[i + 1] === '\n' ? 2 : 1;
      if (rows.length >= maxRows) return { rows, truncated: i < n };
      continue;
    }
    field += ch; i += 1;
  }
  // Final record without a trailing newline.
  if (!options.partial && (field !== '' || row.length > 0)) {
    endRow();
    if (rows.length > maxRows) rows.length = maxRows;
  }
  return { rows, truncated: Boolean(options.partial) };
}

export interface CsvPreview {
  readonly header: string[];
  readonly body: string[][];
  /** Data rows (excluding the header) seen in the text that was read. */
  readonly rowCount: number;
  readonly columnCount: number;
  /** True when the file was larger than what we read, so rowCount is a lower bound. */
  readonly partial: boolean;
}

export function csvPreview(text: string, options: { rows?: number; columns?: number; partial?: boolean } = {}): CsvPreview {
  const maxRows = options.rows ?? 5;
  const maxColumns = options.columns ?? 5;
  const partial = options.partial ?? false;
  const { rows } = parseCsv(text, { partial });
  const columnCount = rows.reduce((max, row) => Math.max(max, row.length), 0);
  const [first = [], ...rest] = rows;
  const pad = (row: string[]) => Array.from({ length: Math.min(columnCount, maxColumns) }, (_, index) => row[index] ?? '');
  return {
    header: pad(first),
    body: rest.slice(0, maxRows).map(pad),
    rowCount: rest.length,
    columnCount,
    partial,
  };
}

export function csvSummary(preview: Pick<CsvPreview, 'rowCount' | 'columnCount' | 'partial'>): string {
  return `${formatCount(preview.rowCount)}행${preview.partial ? ' 이상' : ''} · ${formatCount(preview.columnCount)}열`;
}

/** First few lines of a text file, plus whether more follows. */
export function textPreview(text: string, lines = 6): { readonly text: string; readonly more: boolean } {
  const clean = (text.charCodeAt(0) === 0xfeff ? text.slice(1) : text).replace(/\r\n?/g, '\n').replace(/^\n+/, '');
  const all = clean.split('\n');
  const head = all.slice(0, lines);
  while (head.length && head[head.length - 1]!.trim() === '') head.pop();
  return { text: head.join('\n'), more: all.slice(lines).some(line => line.trim() !== '') };
}

/** Decode the first `cap` bytes of a response body as UTF-8; `complete` is false when the body was longer. */
export async function readCapped(response: Response, cap: number): Promise<{ text: string; complete: boolean }> {
  const decoder = new TextDecoder('utf-8');
  const reader = response.body?.getReader();
  if (!reader) {
    const buffer = new Uint8Array(await response.arrayBuffer());
    const complete = buffer.byteLength <= cap;
    return { text: decoder.decode(complete ? buffer : buffer.subarray(0, cap)), complete };
  }
  let text = '';
  let read = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) return { text: text + decoder.decode(), complete: true };
    const room = cap - read;
    if (value.byteLength > room) {
      // stream: true keeps a cut-off UTF-8 sequence out of the output instead of emitting U+FFFD.
      text += decoder.decode(value.subarray(0, room), { stream: true });
      void reader.cancel().catch(() => undefined);
      return { text, complete: false };
    }
    text += decoder.decode(value, { stream: true });
    read += value.byteLength;
  }
}
