import { useEffect, useId, useRef, useState } from 'react';
import { z } from 'zod';
import { Pencil, Trash2 } from 'lucide-react';
import { Memory, Message } from './types';
import { read, http, errorMessage } from './api';
import { Button, ErrorNotice, IconButton } from './primitives';
const History = z.object({ history: z.array(z.object({ id: z.uuid(), text: z.string(), created_at: z.string(), provenance: z.enum(['original', 'user_correction', 'conversation_correction']), deleted: z.boolean(), current: z.boolean() })) });
const Source = z.object({ message: Message, conversation_id: z.uuid() });
const epistemic = { reported: '사용자가 알려준 내용', inferred: '도우미의 추론', disputed: '서로 다른 설명이 있어요' } as const;
const roles = { user: '사용자', assistant: '도우미', system: '시스템' } as const;
const historyLabels = { original: '처음 저장한 기억', user_correction: '사용자가 직접 정정', conversation_correction: '대화에서 정정' } as const;
const date = (value: string) => new Date(value).toLocaleString('ko-KR', { dateStyle: 'medium', timeStyle: 'short' });

export function MemoryEntry({ memory, onCorrected, onDelete }: { memory: Memory; onCorrected: () => Promise<void>; onDelete: () => void }) {
  const fieldId = useId(), editButton = useRef<HTMLButtonElement>(null);
  const restoreFocus = useRef(false);
  const [editing, setEditing] = useState(false), [text, setText] = useState(memory.text);
  const [requestId, setRequestId] = useState(() => crypto.randomUUID());
  const [busy, setBusy] = useState(false), [error, setError] = useState('');
  const [expanded, setExpanded] = useState(false), [history, setHistory] = useState<z.infer<typeof History>['history']>([]);
  const [historyError, setHistoryError] = useState(''), [historyBusy, setHistoryBusy] = useState(false);
  const [source, setSource] = useState<z.infer<typeof Source> | null>(null), [sourceError, setSourceError] = useState(''), [sourceBusy, setSourceBusy] = useState(false);
  useEffect(() => { if (!editing && restoreFocus.current) { editButton.current?.focus(); restoreFocus.current = false; } }, [editing]);
  const save = async () => {
    if (!text.trim()) { setError('정정할 내용을 입력해 주세요.'); return; }
    setBusy(true); setError('');
    try {
      Memory.parse((await http.post(`/v1/memory/${memory.id}/corrections`, { json: { text, client_correction_id: requestId } }).json<{ memory: unknown }>()).memory);
      await onCorrected(); setEditing(false);
    } catch (failure) { setError(errorMessage(failure)); }
    finally { setBusy(false); }
  };
  const loadHistory = async () => {
    setExpanded(true); setHistoryBusy(true); setHistoryError('');
    try { setHistory((await read(`/v1/memory/${memory.id}/history`, History)).history); }
    catch (failure) { setHistoryError(errorMessage(failure)); }
    finally { setHistoryBusy(false); }
  };
  const loadSource = async () => {
    if (!memory.source_message_id) return;
    setSourceBusy(true); setSourceError('');
    try { setSource(await read(`/v1/sources/${memory.source_message_id}`, Source)); }
    catch (failure) { setSourceError(errorMessage(failure)); }
    finally { setSourceBusy(false); }
  };
  return <article className="memory-entry">
    {(memory.provenance === 'user_correction' || memory.epistemic_status === 'disputed' || memory.epistemic_status === 'reported') && <div className="memory-meta"><span>{memory.provenance === 'user_correction' ? '직접 정정함' : memory.epistemic_status === 'disputed' ? epistemic.disputed : '직접 알려준 내용'}</span></div>}
    <p className="memory-text">{memory.text}</p>
    {!editing && <div className="memory-actions">
      <Button aria-expanded={expanded} aria-controls={`${fieldId}-details`} onClick={() => expanded ? setExpanded(false) : void loadHistory()}>출처</Button>
      <button ref={editButton} className="button" onClick={() => { setText(memory.text); setRequestId(crypto.randomUUID()); setError(''); setEditing(true); }}><Pencil size={14} />정정</button>
      <IconButton label="기억 삭제" onClick={onDelete}><Trash2 size={15} /></IconButton>
    </div>}
    {editing && <form className="memory-edit" onSubmit={event => { event.preventDefault(); void save(); }}>
      <label htmlFor={fieldId}>정정할 내용</label>
      <textarea id={fieldId} name="correction" autoFocus required maxLength={20000} rows={4} value={text} disabled={busy}
        aria-describedby={`${fieldId}-help`} aria-invalid={error && !text.trim() ? true : undefined}
        onChange={event => { setText(event.target.value); setRequestId(crypto.randomUUID()); setError(''); }} />
      <p id={`${fieldId}-help`}>직접 알려준 내용으로 저장돼요. 원문과 이전 기억은 수정 이력에 남아요.</p>
      {error && <ErrorNotice>{error}</ErrorNotice>}
      <div className="memory-actions"><Button type="submit" className="primary" busy={busy}>정정 저장</Button>
        <Button type="button" disabled={busy} onClick={() => { restoreFocus.current = true; setEditing(false); }}>취소</Button></div>
    </form>}
    {expanded && <div className="memory-details" id={`${fieldId}-details`}>
      <dl><div><dt>기억의 성격</dt><dd>{memory.epistemic_status ? epistemic[memory.epistemic_status] : '미분류'}{memory.provenance === 'user_correction' && ' · 직접 정정'}</dd></div>
        {memory.context && <div><dt>맥락</dt><dd>{memory.context}</dd></div>}
        {memory.known_from && <div><dt>저장 시점</dt><dd>{date(memory.known_from)}</dd></div>}
        {(memory.valid_from || memory.valid_to) && <div><dt>적용 시기</dt><dd>{memory.valid_from ? date(memory.valid_from) : '시작 미상'} ~ {memory.valid_to ? date(memory.valid_to) : '종료 미상'}</dd></div>}
      </dl>
      {memory.source_message_id ? <div className="memory-source">
        <h3>{memory.provenance === 'user_correction' ? '정정 전 기억의 원문' : '기억의 원문'}</h3>
        <p className="memory-meta">{memory.source_role && roles[memory.source_role]}{memory.source_created_at && ` · ${date(memory.source_created_at)}`}</p>
        <blockquote>{memory.source_excerpt}</blockquote>
        {!source && <Button busy={sourceBusy} onClick={() => void loadSource()}>{sourceError ? '원문 다시 불러오기' : '원문 전체 보기'}</Button>}
        {sourceError && <ErrorNotice>{sourceError}</ErrorNotice>}
        {source && <div className="memory-original"><p>{source.message.content}</p>{source.message.attachments?.map(file => <a key={file.id} href={`/v1/artifacts/${file.id}/content`} download={file.name}>{file.name}</a>)}</div>}
      </div> : <p className="memory-meta">사용자가 직접 저장한 기억이에요. 연결된 대화 원문은 없어요.</p>}
      <h3>수정 이력</h3>
      {historyBusy && <p role="status">이력을 불러오는 중이에요.</p>}
      {historyError && <><ErrorNotice>{historyError}</ErrorNotice><Button onClick={() => void loadHistory()}>이력 다시 불러오기</Button></>}
      <ol className="memory-history">{history.map(version => <li key={version.id}><p className="memory-meta">{historyLabels[version.provenance]} · {date(version.created_at)}{version.current ? ' · 현재 적용' : version.deleted ? ' · 기억에서 제외' : ' · 이전 내용'}</p><p>{version.text}</p></li>)}</ol>
    </div>}
  </article>;
}
