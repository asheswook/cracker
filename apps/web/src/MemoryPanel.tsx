import { useCallback, useEffect, useRef, useState } from 'react';
import { Layers3 } from 'lucide-react';
import { http, errorMessage } from './api';
import { Memory, Resources } from './types';
import { Button, Empty, ErrorNotice } from './primitives';
import { MemoryEntry } from './MemoryEntry';
import './memory.css';
import { LoadingSkeleton } from './LoadingSkeleton';

export function MemoryPanel() {
  const [memories, setMemories] = useState<Memory[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');
  const [notice, setNotice] = useState('');
  const [query, setQuery] = useState('');
  const latestQuery = useRef('');
  const request = useRef(0);
  const controller = useRef<AbortController | null>(null);
  const [forget, setForget] = useState<Memory | null>(null);
  const [deleting, setDeleting] = useState(false);
  const [deleteError, setDeleteError] = useState('');
  const confirmation = useRef<HTMLDialogElement>(null);
  const load = useCallback(async () => {
    const version = ++request.current;
    const searchQuery = latestQuery.current.trim();
    controller.current?.abort();
    const abort = new AbortController();
    controller.current = abort;
    setLoading(true); setError('');
    try {
      const result = Resources.memories.parse(await http.get(`/v1/memory${searchQuery ? `?q=${encodeURIComponent(searchQuery)}` : ''}`, { signal: abort.signal }).json());
      if (request.current === version) setMemories(result.memories);
    }
    catch (failure) { if (request.current === version && !abort.signal.aborted) setError(errorMessage(failure)); }
    finally { if (request.current === version) setLoading(false); }
  }, []);
  useEffect(() => {
    const timer = setTimeout(() => void load(), query ? 250 : 0);
    return () => { clearTimeout(timer); request.current++; controller.current?.abort(); };
  }, [load, query]);
  const search = (value: string) => {
    request.current++; controller.current?.abort();
    latestQuery.current = value;
    setQuery(value); setLoading(true); setError(''); setNotice('');
  };
  useEffect(() => {
    if (forget) confirmation.current?.showModal(); else confirmation.current?.close();
  }, [forget]);
  const remove = async () => {
    if (!forget) return;
    setDeleting(true); setDeleteError('');
    try {
      await http.delete(`/v1/memory/${forget.id}`);
      setForget(null); setNotice('기억에서 제외했어요. 원문과 수정 이력은 보존돼요.'); await load();
    } catch (failure) { setDeleteError(errorMessage(failure)); }
    finally { setDeleting(false); }
  };
  return <section className="memory-panel" aria-label="저장된 기억">
    <div className="memory-search" role="search" aria-label="기억 검색">
      <label htmlFor="memory-search" className="visually-hidden">기억 검색</label>
      <div><input id="memory-search" type="search" autoComplete="off" maxLength={500} value={query} onChange={event => search(event.target.value)} placeholder="기억 찾기" aria-controls="memory-results" />
</div>
    </div>
    <p className="memory-notice" role="status">{loading ? '' : error ? '' : notice || (memories.length === 100 ? '결과가 많아요. 검색어를 더 구체적으로 입력해 보세요.' : '')}</p>
    {error && <div><ErrorNotice>{error}</ErrorNotice><Button onClick={() => void load()}>다시 시도</Button></div>}
    {loading && memories.length === 0 && !error && <LoadingSkeleton layout="cards" label="기억을 불러오는 중…" />}
    {!loading && !error && memories.length === 0 && <Empty icon={<Layers3 size={24} />} title={query.trim() ? '찾는 기억이 없어요' : '아직 기억이 없어요'}>{query.trim() ? '다른 단어로 찾아보세요.' : '대화하면서 기억할 내용이 생기면 여기에 모여요.'}</Empty>}
    <div className="memory-list" id="memory-results" aria-busy={loading} hidden={loading || Boolean(error)}>{memories.map(memory => <MemoryEntry key={memory.id} memory={memory}
      onCorrected={async () => { setNotice('정정한 내용을 저장했어요. 이후 기억 조회부터 적용돼요.'); await load(); }}
      onDelete={() => { setDeleteError(''); setForget(memory); }} />)}</div>
    <dialog ref={confirmation} className="confirm-dialog" aria-labelledby="forget-title" onCancel={event => { event.stopPropagation(); setForget(null); }}>
      <h2 id="forget-title">이 기억을 잊을까요?</h2>
      <p>{forget?.provenance === 'user_correction'
        ? '이 기억과 이전 정정본을 이후 기억 조회에서 제외해요. 같은 원문에서 나온 다른 기억은 유지돼요.'
        : forget?.source_message_id
          ? '같은 원문에서 나온 기억도 함께 제외하며, 그 원문에서 다시 추출하지 않아요.'
          : '이 기억을 이후 기억 조회에서 제외해요.'} 원문과 수정 이력은 보존돼요.</p>
      {deleteError && <ErrorNotice>{deleteError}</ErrorNotice>}
      <div><Button autoFocus onClick={() => setForget(null)} disabled={deleting}>유지하기</Button>
        <Button className="danger" busy={deleting} onClick={() => void remove()}>기억 삭제</Button></div>
    </dialog>
  </section>;
}
