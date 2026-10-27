import { useEffect, useId, useRef, useState, type ReactNode, type RefObject } from 'react';
import { Download, File, FileArchive, FileImage, FileSpreadsheet, FileText, X } from 'lucide-react';
import { http } from './api';
import type { Artifact } from './types';
import { MarkdownMessage } from './MarkdownMessage';
import {
  artifactKind, canOpenInline, csvPreview, formatCount, hasTextPreview,
  parseCsv, readCapped, textPreview, type ArtifactKind,
} from './artifact-preview';
import './artifact-card.css';

const PREVIEW_CAP = 200 * 1024;
const SHEET_TEXT_CAP = 4 * 1024 * 1024;
const SHEET_ROWS = 1000;
const PREVIEW_ERROR = '미리보기를 불러오지 못했어요';

const contentPath = (artifact: Artifact) => `/v1/artifacts/${artifact.id}/content`;
const artifactTitle = (artifact: Artifact) => artifact.previous_id && artifact.series_key ? artifact.series_key : artifact.name;

type Load<T> = { status: 'idle' | 'loading' } | { status: 'ready'; value: T } | { status: 'error' };

/** Becomes true once the element is near the viewport, then stays true. */
function useNearViewport<T extends Element>(): [RefObject<T | null>, boolean] {
  const ref = useRef<T>(null);
  const [seen, setSeen] = useState(false);
  useEffect(() => {
    if (seen) return;
    const node = ref.current;
    if (!node || typeof IntersectionObserver === 'undefined') { setSeen(true); return; }
    const observer = new IntersectionObserver(entries => {
      if (entries.some(entry => entry.isIntersecting)) { setSeen(true); observer.disconnect(); }
    }, { rootMargin: '240px 0px' });
    observer.observe(node);
    return () => observer.disconnect();
  }, [seen]);
  return [ref, seen];
}

function useArtifactText(artifact: Artifact, cap: number, enabled: boolean): Load<{ text: string; complete: boolean }> {
  const [state, setState] = useState<Load<{ text: string; complete: boolean }>>({ status: 'idle' });
  useEffect(() => {
    if (!enabled || artifact.state !== 'ready') return;
    const abort = new AbortController();
    setState({ status: 'loading' });
    void http.get(contentPath(artifact), { signal: abort.signal })
      .then(response => readCapped(response, cap))
      .then(value => { if (!abort.signal.aborted) setState({ status: 'ready', value }); })
      .catch(() => { if (!abort.signal.aborted) setState({ status: 'error' }); });
    return () => abort.abort();
  }, [artifact.id, artifact.state, cap, enabled]);
  return state;
}

function useArtifactBlobUrl(artifact: Artifact, type: string, enabled: boolean): Load<string> {
  const [state, setState] = useState<Load<string>>({ status: 'idle' });
  useEffect(() => {
    if (!enabled || artifact.state !== 'ready') return;
    const abort = new AbortController();
    let url = '';
    setState({ status: 'loading' });
    void http.get(contentPath(artifact), { signal: abort.signal }).blob()
      .then(blob => {
        if (abort.signal.aborted) return;
        url = URL.createObjectURL(new Blob([blob], { type }));
        setState({ status: 'ready', value: url });
      })
      .catch(() => { if (!abort.signal.aborted) setState({ status: 'error' }); });
    return () => {
      abort.abort();
      if (url) URL.revokeObjectURL(url);
    };
  }, [artifact.id, artifact.state, type, enabled]);
  return state;
}

function KindIcon({ kind, size = 18 }: { kind: ArtifactKind; size?: number }) {
  if (kind === 'csv') return <FileSpreadsheet size={size} aria-hidden />;
  if (kind === 'image') return <FileImage size={size} aria-hidden />;
  if (kind === 'zip') return <FileArchive size={size} aria-hidden />;
  if (kind === 'other') return <File size={size} aria-hidden />;
  return <FileText size={size} aria-hidden />;
}

function CsvTable({ header, body, label, sticky = false }: { header: string[]; body: string[][]; label: string; sticky?: boolean }) {
  return (
    <table className="artifact-table" data-sticky={sticky || undefined} aria-label={label}>
      <thead>
        <tr>{header.map((cell, index) => <th key={index} scope="col">{cell}</th>)}</tr>
      </thead>
      <tbody>
        {body.map((row, rowIndex) => (
          <tr key={rowIndex}>{row.map((cell, index) => <td key={index}>{cell}</td>)}</tr>
        ))}
      </tbody>
    </table>
  );
}

function CardPreview({ artifact, kind, enabled }: { artifact: Artifact; kind: ArtifactKind; enabled: boolean }) {
  const text = useArtifactText(artifact, PREVIEW_CAP, enabled && hasTextPreview(kind));
  const image = useArtifactBlobUrl(artifact, artifact.media_type, enabled && kind === 'image');
  const [imageBroken, setImageBroken] = useState(false);
  if (kind === 'image') {
    if (image.status === 'error' || imageBroken) return <p className="artifact-preview-error" role="status">{PREVIEW_ERROR}</p>;
    if (image.status !== 'ready') return <div className="artifact-preview-image" data-loading aria-hidden />;
    return (
      <div className="artifact-preview-image">
        <img src={image.value} alt={artifact.name} onError={() => setImageBroken(true)} />
      </div>
    );
  }
  if (!hasTextPreview(kind)) return null;
  if (text.status === 'error') return <p className="artifact-preview-error" role="status">{PREVIEW_ERROR}</p>;
  if (text.status !== 'ready') return <div className="artifact-preview-text" data-loading aria-hidden />;
  if (kind === 'csv') {
    const preview = csvPreview(text.value.text, { partial: !text.value.complete });
    if (!preview.columnCount) return null;
    return (
      <div className="artifact-preview-csv">
        <div className="artifact-table-scroll">
          <CsvTable header={preview.header} body={preview.body} label={`${artifact.name} 미리보기`} />
        </div>
      </div>
    );
  }
  const lines = textPreview(text.value.text);
  if (!lines.text) return null;
  return <pre className="artifact-preview-text" data-more={lines.more || !text.value.complete || undefined}>{lines.text}</pre>;
}

function SheetBody({ artifact, kind }: { artifact: Artifact; kind: ArtifactKind }) {
  const isText = kind === 'csv' || kind === 'markdown' || kind === 'text';
  const text = useArtifactText(artifact, SHEET_TEXT_CAP, isText);
  const blobType = kind === 'pdf' ? 'application/pdf' : artifact.media_type;
  const blob = useArtifactBlobUrl(artifact, blobType, kind === 'image' || kind === 'pdf');
  const state = isText ? text.status : blob.status;
  if (state === 'error') return <SheetMessage>{PREVIEW_ERROR}</SheetMessage>;
  if (isText && text.status === 'ready') {
    const { text: body, complete } = text.value;
    if (kind === 'csv') {
      const { rows, truncated } = parseCsv(body, { maxRows: SHEET_ROWS + 1, partial: !complete });
      const columns = rows.reduce((max, row) => Math.max(max, row.length), 0);
      const pad = (row: string[]) => Array.from({ length: columns }, (_, index) => row[index] ?? '');
      const [header = [], ...data] = rows;
      const cut = truncated || !complete;
      return (
        <>
          <div className="artifact-sheet-table">
            <CsvTable header={pad(header)} body={data.map(pad)} label={artifact.name} sticky />
          </div>
          {cut && <p className="artifact-sheet-note">처음 {formatCount(data.length)}행만 보여요</p>}
        </>
      );
    }
    return (
      <div className="artifact-sheet-doc">
        {kind === 'markdown' ? <MarkdownMessage content={body} /> : <pre>{body}</pre>}
        {!complete && <p className="artifact-sheet-note">앞부분만 보여요</p>}
      </div>
    );
  }
  if (!isText && blob.status === 'ready') {
    if (kind === 'image') return <div className="artifact-sheet-image"><img src={blob.value} alt={artifact.name} /></div>;
    return <iframe className="artifact-sheet-pdf" src={blob.value} title={artifact.name} />;
  }
  return <div className="artifact-sheet-loading" role="status">불러오는 중…</div>;
}

/** The viewer's own message (the header keeps the one download). */
function SheetMessage({ children }: { children: ReactNode }) {
  return <div className="artifact-sheet-message" role="status"><p>{children}</p></div>;
}

function ArtifactSheet({ artifact, kind, onClose }: { artifact: Artifact; kind: ArtifactKind; onClose: () => void }) {
  const ref = useRef<HTMLDialogElement>(null);
  const titleId = useId();
  useEffect(() => {
    const dialog = ref.current;
    const trigger = document.activeElement instanceof HTMLElement ? document.activeElement : null;
    // showModal makes the rest of the page inert (focus stays inside) and closes on Esc via `cancel`.
    if (dialog && !dialog.open) dialog.showModal();
    return () => {
      dialog?.close();
      trigger?.focus();
    };
  }, []);
  return (
    <dialog
      ref={ref}
      className="artifact-sheet"
      data-kind={kind}
      aria-labelledby={titleId}
      onCancel={event => { event.preventDefault(); onClose(); }}
      // React events bubble through the component tree even from the top layer; keep sheet input away from message handlers.
      onClick={event => { event.stopPropagation(); if (event.target === event.currentTarget) onClose(); }}
      onKeyDown={event => event.stopPropagation()}
      onPointerDown={event => event.stopPropagation()}
    >
      <header className="artifact-sheet-header">
        <span className="artifact-icon" data-kind={kind}><KindIcon kind={kind} /></span>
        <div className="artifact-sheet-title">
          <h2 id={titleId}>{artifactTitle(artifact)}</h2>
          {artifact.previous_id && artifact.change_summary?.trim() && <span>{artifact.change_summary.trim()}</span>}
        </div>
        <a className="artifact-sheet-button" href={contentPath(artifact)} download={artifact.name} aria-label="다운로드" title="다운로드">
          <Download size={18} aria-hidden />
        </a>
        <button type="button" className="artifact-sheet-button" onClick={onClose} aria-label="닫기" title="닫기" autoFocus>
          <X size={20} aria-hidden />
        </button>
      </header>
      <div className="artifact-sheet-body" tabIndex={-1}>
        <SheetBody artifact={artifact} kind={kind} />
      </div>
    </dialog>
  );
}

/**
 * A file in the conversation: the file itself (a small preview when there is one, its name and icon).
 * Tapping opens it; download lives in the viewer. Files with nothing to show (zip, docx) download on tap.
 */
export function ArtifactCard({ artifact }: { artifact: Artifact }) {
  const kind = artifactKind(artifact.media_type, artifact.name);
  const title = artifactTitle(artifact);
  const summary = artifact.previous_id ? artifact.change_summary?.trim() : null;
  const [ref, near] = useNearViewport<HTMLDivElement>();
  const [open, setOpen] = useState(false);
  if (artifact.state === 'deleted')
    return <span className="attachment-deleted">삭제된 파일 · {artifact.name}</span>;
  // The name is the control; its hit area stretches over the whole card (a table cannot live inside a button).
  return (
    <div ref={ref} className="artifact-card" data-kind={kind}>
      <CardPreview artifact={artifact} kind={kind} enabled={near} />
      <span className="artifact-row">
        <span className="artifact-icon" data-kind={kind}><KindIcon kind={kind} /></span>
        <span className="artifact-label">
          {canOpenInline(kind)
            ? <button type="button" className="artifact-name artifact-open" title={artifact.name} onClick={() => setOpen(true)} aria-haspopup="dialog">{title}</button>
            : <a className="artifact-name artifact-open" title={artifact.name} href={contentPath(artifact)} download={artifact.name}>{title}</a>}
          {summary && <span className="artifact-summary">{summary}</span>}
        </span>
      </span>
      {open && <ArtifactSheet artifact={artifact} kind={kind} onClose={() => setOpen(false)} />}
    </div>
  );
}
