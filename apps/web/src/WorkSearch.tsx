import { useEffect, useRef, useState } from 'react';
import { FileSearch, Download, RefreshCw } from 'lucide-react';
import { WorkSearchPage, PriorSourcePage } from '../../../packages/protocol/work-search';
import { http, errorMessage } from './api';
import { Id } from './types';
import { Button, Empty } from './primitives';
import { ScheduleObjective } from './ScheduleObjective';
import { WorkOpenAction } from './WorkOpenAction';
import { createWorkSession } from './work-session';
import type { SearchPage, WorkSession } from './work-session';
import './schedules.css';

type Hit = SearchPage['hits'][number];
function Source({ hit, session }: { readonly hit: Hit; readonly session: WorkSession }) {
  const key = `source:${hit.source_message_id}`;
  const [open, setOpen] = useState(session.disclosures.has(key));
  const [source, setSource] = useState(session.sources.get(hit.source_message_id) ?? null);
  const [error, setError] = useState('');
  const [loading, setLoading] = useState(false);
  const [retry, setRetry] = useState(0);
  useEffect(() => {
    if (!open || source) return;
    const controller = new AbortController();
    setLoading(true); setError('');
    void http.get(`/v1/sources/${hit.source_message_id}`, { signal: controller.signal }).json<unknown>()
      .then(raw => {
        const next = PriorSourcePage.parse(raw);
        if (next.conversation_id !== hit.conversation_id || next.message.id !== hit.source_message_id)
          throw new Error('Source identity mismatch');
        if (!controller.signal.aborted) { session.sources.set(hit.source_message_id, next); setSource(next); }
      })
      .catch(error => { if (!controller.signal.aborted) setError(errorMessage(error)); })
      .finally(() => { if (!controller.signal.aborted) setLoading(false); });
    return () => controller.abort();
  }, [open, source, hit.conversation_id, hit.source_message_id, retry, session]);
  return <details className="work-source" open={open} onToggle={event => {
    const expanded = event.currentTarget.open;
    if (expanded) session.disclosures.add(key); else session.disclosures.delete(key);
    setOpen(expanded);
  }}>
    <summary>원문 보기</summary>
    {loading && <p role="status">원문을 불러오는 중…</p>}
    {error && <div role="alert"><p>{error}</p><Button className="small-button" onClick={() => setRetry(value => value + 1)}>원문 다시 시도</Button></div>}
    {source && <p className="search-source">{source.message.content || '텍스트 없이 파일만 보냈어요.'}</p>}
  </details>;
}

export function WorkSearch({ query, filter, onSource, session: suppliedSession }: {
  readonly query: string;
  readonly filter: string;
  readonly onSource: (conversation: Id, message: Id) => Promise<void> | void;
  readonly session?: WorkSession;
}) {
  const localSession = useRef(createWorkSession());
  const session = suppliedSession ?? localSession.current;
  const state = filter === 'active' ? 'active' : filter === 'finished' ? 'finished' : 'all';
  const key = `${query.trim()}:${state}`;
  const [page, setPage] = useState<SearchPage | null>(() => session.searchKey === key ? session.page : null);
  const [error, setError] = useState('');
  const [loading, setLoading] = useState(!page && query.trim().length >= 2);
  const request = useRef<AbortController | null>(null);
  const lastLoad = useRef<{ cursor: SearchPage['next_cursor']; append: boolean }>({ cursor: null, append: false });
  async function load(cursor: SearchPage['next_cursor'], append: boolean) {
    request.current?.abort();
    const controller = new AbortController(); request.current = controller;
    lastLoad.current = { cursor, append };
    setLoading(true); setError('');
    try {
      const next = WorkSearchPage.parse(await http.post('/v1/search', { json: { query: query.trim(), cursor, conversation_id: null, state, limit: 15 }, signal: controller.signal }).json<unknown>());
      if (controller.signal.aborted) return;
      const previous = session.searchKey === key ? session.page : null;
      const merged = { ...next, hits: append && previous ? [...previous.hits, ...next.hits] : next.hits };
      session.searchKey = key; session.page = merged;
      setPage(merged);
    } catch (error) { if (!controller.signal.aborted) setError(errorMessage(error)); }
    finally { if (!controller.signal.aborted) setLoading(false); }
  }
  useEffect(() => {
    if (session.searchKey === key && session.page) { setPage(session.page); setLoading(false); return; }
    setPage(null); setError(''); setLoading(query.trim().length >= 2);
    if (query.trim().length < 2) return;
    const timer = setTimeout(() => void load(null, false), 250);
    return () => clearTimeout(timer);
  }, [key, session]);
  useEffect(() => () => { request.current?.abort(); }, [key]);
  if (query.trim().length < 2) return <p role="status">두 글자 이상 입력해 주세요.</p>;
  return <div className="work-search-results">
    <div className="search-options">
      <details className="search-coverage">
        <summary>검색 범위와 제한</summary>
        <p>대화 본문 · 맡긴 일 · 파일명 · 텍스트·PDF·DOCX 파일 내용</p>
        <p>파일 내용은 읽을 수 있는 앞부분 최대 20만 자를 검색해요. PDF는 처음 100쪽, DOCX는 본문을 검색하며 이미지 속 글자는 제외돼요.</p>
      </details>
      <Button className="small-button" busy={loading} onClick={() => void load(null, false)}><RefreshCw size={13} />새로고침</Button>
    </div>
    {loading && <p role="status">검색 중…</p>}
    {error && <div role="alert"><p>{error}</p><Button onClick={() => void load(lastLoad.current.cursor, lastLoad.current.append)}>다시 시도</Button></div>}
    {page && page.unindexed_text_files > 0 && <p role="status">이전 텍스트 파일 {page.unindexed_text_files}개를 준비 중이에요. <Button className="small-button" onClick={() => void load(null, false)}>계속 검색</Button></p>}
    {page && page.pending_document_files > 0 && <p role="status">PDF·DOCX 파일 {page.pending_document_files}개의 본문 검색을 준비 중이에요. 컴퓨터가 연결되어 있고 다른 작업을 하지 않을 때 자동으로 진행해요.</p>}
    {page && page.failed_document_files > 0 && <p role="status">PDF·DOCX 파일 {page.failed_document_files}개의 내용을 읽지 못했어요. 파일명으로 찾거나 원본 파일을 확인해 주세요.</p>}
    {page && !loading && !page.hits.length && page.unindexed_text_files === 0 && page.pending_document_files === 0 && page.failed_document_files === 0 && <Empty icon={<FileSearch size={24} />} title="일치하는 원문이 없어요">다른 표현이나 파일명으로 찾아보세요.</Empty>}
    <div className="resource-list">{page?.hits.map(hit => <article className="resource-item" key={`${hit.kind}:${hit.id}`} data-source-id={hit.source_message_id}>
      <div className="resource-meta"><span>{hit.artifact ? '파일' : hit.source_role === 'user' ? '내 메시지' : hit.source_role === 'assistant' ? '답변' : '자동 실행'}</span><time dateTime={hit.created_at}>{new Date(hit.created_at).toLocaleDateString('ko-KR')}</time></div>
      <ScheduleObjective objective={hit.artifact?.name ?? hit.task?.objective ?? hit.conversation_title}
        open={session.disclosures.has(`objective:${hit.kind}:${hit.id}`)} onToggle={open => {
          const key = `objective:${hit.kind}:${hit.id}`;
          if (open) session.disclosures.add(key); else session.disclosures.delete(key);
        }} />
      <small className="search-conversation">{hit.conversation_title}</small>
      <p className="search-source search-excerpt">{hit.snippet}</p>
      {hit.file_text_truncated && <small>파일 앞부분에서 찾았어요.</small>}
      <Source hit={hit} session={session} />
      <div className="work-actions">
        <WorkOpenAction onOpen={() => onSource(Id.parse(hit.conversation_id), Id.parse(hit.source_message_id))}>메시지 보기</WorkOpenAction>
        {hit.artifact && <a href={`/v1/artifacts/${hit.artifact.id}/content`} download={hit.artifact.name}><Download size={13} /> 원본 파일</a>}
      </div>
    </article>)}</div>
    {page?.next_cursor && <Button busy={loading} onClick={() => void load(page.next_cursor, true)}>더 보기</Button>}
  </div>;
}
