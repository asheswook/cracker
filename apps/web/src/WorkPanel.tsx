import { useEffect, useLayoutEffect, useRef, useState } from 'react';
import { Bot, ChevronRight, CircleAlert, CircleCheck, CircleSlash, ListChecks, Search, Square } from 'lucide-react';
import type { Id, Task } from './types';
import { Empty } from './primitives';
import { WorkSearch } from './WorkSearch';
import { errorMessage } from './api';
import { WorkNavigationError } from './WorkOpenAction';
import { createWorkSession } from './work-session';
import type { WorkSession } from './work-session';
import type { TaskDestination } from './useWorkNavigation';
import { stoppable, useStopConfirm } from './task-stop';
import { activeTasks, dayLabel, finishedByDay, finishedStatus, liveStatus, taskTitle } from './work-list';
import './schedules.css';
import './work-search.css';
import './work.css';

const PAGE = 20;

/** A whole row is the link; while it opens it says so, and a failure stays next to it. */
/** 멈추기 on a running row: tap once to ask, tap again to stop. The answer replaces the row's status until it settles. */
function StopControl({ task, stop }: { readonly task: Task; readonly stop: ReturnType<typeof useStopConfirm> }) {
  if (!stoppable(task) || stop.stopping) return null;
  if (stop.asking) return (
    <span className="work-stop-ask" role="group" aria-label="멈출까요?">
      <span className="work-stop-question" aria-hidden="true">멈출까요?</span>
      <button type="button" className="work-stop-confirm" onClick={() => void stop.confirm()} disabled={stop.busy} autoFocus>{stop.busy ? '멈추는 중…' : '멈추기'}</button>
      <button type="button" className="work-stop-cancel" onClick={stop.cancel} disabled={stop.busy}>취소</button>
    </span>
  );
  return (
    <button type="button" className="work-stop" onClick={stop.ask} aria-label={`멈추기: ${taskTitle(task)}`}>
      <Square size={12} fill="currentColor" aria-hidden="true" /><span>멈추기</span>
    </button>
  );
}

function TaskRow({ task, line, tone, destination, onOpen, quiet = false, live = false }: {
  readonly task: Task;
  readonly line: string;
  readonly tone: 'live' | 'wait' | 'attention' | 'done' | 'failed' | 'cancelled';
  readonly destination: TaskDestination;
  readonly onOpen: (task: Task, sourceMessageId?: Id, destination?: TaskDestination) => Promise<void> | void;
  readonly quiet?: boolean;
  /** A row of 하고 있는 일: it carries a 멈추기 control. */
  readonly live?: boolean;
}) {
  const stop = useStopConfirm(live ? task.id : null);
  const status = stop.stopping || task.state === 'cancelling' ? '멈추는 중' : line;
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const mounted = useRef(true);
  useEffect(() => { mounted.current = true; return () => { mounted.current = false; }; }, []);
  const open = async () => {
    setBusy(true); setError('');
    try { await onOpen(task, undefined, destination); }
    catch (e) { if (mounted.current) setError(e instanceof WorkNavigationError ? e.message : errorMessage(e)); }
    finally { if (mounted.current) setBusy(false); }
  };
  const Icon = tone === 'failed' || tone === 'attention' ? CircleAlert : tone === 'cancelled' ? CircleSlash : tone === 'done' ? CircleCheck : null;
  const title = taskTitle(task);
  return (
    <li className="work-row" data-tone={stop.stopping ? 'wait' : tone} data-quiet={quiet || undefined} data-task-id={task.id} data-live={live || undefined} data-asking={stop.asking || undefined}>
      <button type="button" className="work-main" onClick={() => void open()} aria-busy={busy || undefined}
        aria-label={`${title}, ${status}. ${destination === 'reply' ? '답변 열기' : '요청 열기'}`}>
        <span className="work-mark" aria-hidden="true">
          {Icon ? <Icon size={quiet ? 14 : 16} strokeWidth={1.9} /> : <span className="work-pulse" />}
        </span>
        <span className="work-text">
          <span className="work-title">{title}</span>
          <span className="work-line">{busy ? '여는 중…' : status}</span>
        </span>
        <ChevronRight size={16} aria-hidden="true" className="work-chevron" />
      </button>
      {live && <StopControl task={task} stop={stop} />}
      {(error || stop.error) && <p className="work-error" role="alert">{error || stop.error}</p>}
    </li>
  );
}

/**
 * 맡긴 일: what is still going on first, then what finished, by day.
 * The assistant's own runs (watches, drafts, sends, briefs) fold into one row per day so they never bury requests.
 * A row opens the conversation: at the answer when it succeeded, otherwise at the request.
 */
export function WorkPanel({
  tasks,
  onOpen,
  onSource,
  session: suppliedSession,
}: {
  tasks: Task[];
  onOpen: (task: Task, sourceMessageId?: Id, destination?: TaskDestination) => Promise<void> | void;
  onSource: (conversation: Id, message: Id) => Promise<void> | void;
  session?: WorkSession;
}) {
  const localSession = useRef(createWorkSession());
  const session = suppliedSession ?? localSession.current;
  const [query, setQuery] = useState(session.query);
  const [limit, setLimit] = useState(PAGE);
  const [, rerender] = useState(0);
  const section = useRef<HTMLElement>(null);
  // The status filter is gone from this screen; search covers everything.
  session.filter = 'all';
  useLayoutEffect(() => {
    const owner = section.current?.closest('.inspector-body');
    if (!(owner instanceof HTMLElement)) return;
    const saved = session.scrollTop;
    owner.scrollTop = saved;
    const frame = requestAnimationFrame(() => { owner.scrollTop = saved; });
    const save = () => { session.scrollTop = owner.scrollTop; };
    owner.addEventListener('scroll', save, { passive: true });
    return () => { cancelAnimationFrame(frame); owner.removeEventListener('scroll', save); owner.scrollTop = 0; };
  }, [session]);
  const resetReading = () => {
    session.page = null;
    session.searchKey = '';
    session.scrollTop = 0;
    session.disclosures.clear();
    session.sources.clear();
    section.current?.closest('.inspector-body')?.scrollTo({ top: 0, behavior: 'instant' });
  };
  const now = new Date();
  const active = activeTasks(tasks);
  const { days, more } = finishedByDay(tasks, limit);
  const searching = query.trim().length > 0;

  return (
    <section className="work-panel work-v2" aria-label="맡긴 일" ref={section}>
      <div className="work-search-field">
        <Search size={16} aria-hidden="true" />
        <input
          type="search"
          aria-label="맡긴 일 검색"
          placeholder="검색"
          maxLength={200}
          value={query}
          onChange={(event) => { if (event.target.value.trim() !== query.trim()) resetReading(); session.query = event.target.value; setQuery(event.target.value); }}
        />
      </div>
      {searching ? <WorkSearch key={query.trim()} query={query} filter="all" onSource={onSource} session={session} /> : !tasks.length ? (
        <Empty icon={<ListChecks size={24} />} title="아직 맡긴 일이 없어요">메시지로 일을 맡기면 진행 상황과 결과가 여기 모여요.</Empty>
      ) : (
        <>
          <section className="work-section" aria-labelledby="work-active">
            <h2 id="work-active" className="work-label">하고 있는 일{active.length > 0 && <span className="work-count">{active.length}</span>}</h2>
            {active.length ? (
              <ul className="work-list">
                {active.map(task => { const s = liveStatus(task, now); return <TaskRow key={task.id} task={task} line={s.text} tone={s.tone} destination="request" onOpen={onOpen} live />; })}
              </ul>
            ) : <p className="work-calm">지금 하고 있는 일은 없어요.</p>}
          </section>
          {days.length > 0 && <h2 className="work-label work-label-major">끝난 일</h2>}
          {days.map(({ day, requests, routine }) => {
            const key = `routine:${day}`;
            return (
              <section key={day} className="work-section" aria-labelledby={`work-day-${day}`}>
                <h3 id={`work-day-${day}`} className="work-label">{dayLabel(day, now)}</h3>
                <ul className="work-list">
                  {requests.map(task => {
                    const s = finishedStatus(task);
                    return <TaskRow key={task.id} task={task} line={s.text} tone={task.state === 'succeeded' ? 'done' : task.state === 'cancelled' ? 'cancelled' : 'failed'}
                      destination={task.state === 'succeeded' ? 'reply' : 'request'} onOpen={onOpen} />;
                  })}
                  {routine.length > 0 && (
                    <li className="work-fold-item">
                      <details className="work-fold" open={session.disclosures.has(key)}
                        onToggle={e => { if (e.currentTarget.open) session.disclosures.add(key); else session.disclosures.delete(key); rerender(n => n + 1); }}>
                        <summary>
                          <span className="work-mark" aria-hidden="true"><Bot size={16} strokeWidth={1.9} /></span>
                          <span className="work-text">
                            <span className="work-title">자동으로 한 일 {routine.length}개</span>
                            <span className="work-line">메일 확인, 답장 초안 같은 일{routine.some(t => t.state === 'failed') ? ` · 실패 ${routine.filter(t => t.state === 'failed').length}개` : ''}</span>
                          </span>
                          <ChevronRight size={16} aria-hidden="true" className="work-chevron work-fold-chevron" />
                        </summary>
                        {session.disclosures.has(key) && (
                          <ul className="work-list">
                            {routine.map(task => {
                              const s = finishedStatus(task);
                              return <TaskRow key={task.id} quiet task={task} line={s.text} tone={task.state === 'succeeded' ? 'done' : task.state === 'cancelled' ? 'cancelled' : 'failed'}
                                destination={task.state === 'succeeded' ? 'reply' : 'request'} onOpen={onOpen} />;
                            })}
                          </ul>
                        )}
                      </details>
                    </li>
                  )}
                </ul>
              </section>
            );
          })}
          {more && <button type="button" className="work-more" onClick={() => setLimit(l => l + PAGE)}>더 보기</button>}
        </>
      )}
    </section>
  );
}
