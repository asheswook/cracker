import { useEffect, useLayoutEffect, useRef, useState } from 'react';
import { ChevronRight, CircleAlert, Search } from 'lucide-react';
import type { Id, Task } from './types';
import { WorkSearch } from './WorkSearch';
import { errorMessage } from './api';
import { WorkNavigationError } from './WorkOpenAction';
import { createWorkSession } from './work-session';
import type { WorkSession } from './work-session';
import type { TaskDestination } from './useWorkNavigation';
import { activeTasks, dayLabel, finishedByDay, finishedStatus, liveStatus, taskTitle } from './work-list';
import './schedules.css';
import './work-search.css';
import './work.css';

const PAGE = 20;

/** A whole row is the link; while it opens it says so, and a failure stays next to it. */
function TaskRow({ task, line, tone, destination, onOpen, quiet = false }: {
  readonly task: Task;
  readonly line: string;
  readonly tone: 'live' | 'wait' | 'attention' | 'done' | 'failed' | 'cancelled';
  readonly destination: TaskDestination;
  readonly onOpen: (task: Task, sourceMessageId?: Id, destination?: TaskDestination) => Promise<void> | void;
  readonly quiet?: boolean;
}) {
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
  // A mark only where something is off; finished rows carry none, running ones a soft pulse.
  const Icon = tone === 'failed' || tone === 'attention' ? CircleAlert : null;
  const title = taskTitle(task);
  return (
    <li className="work-row" data-tone={tone} data-quiet={quiet || undefined} data-task-id={task.id}>
      <button type="button" className="work-main" onClick={() => void open()} aria-busy={busy || undefined}
        aria-label={`${title}, ${line}. ${destination === 'reply' ? '답변 열기' : '요청 열기'}`}>
        <span className="work-mark" aria-hidden="true">
          {Icon ? <Icon size={quiet ? 14 : 16} strokeWidth={1.9} /> : tone === 'done' ? null : <span className="work-pulse" />}
        </span>
        <span className="work-text">
          <span className="work-title">{title}</span>
          <span className="work-line">{busy ? '여는 중…' : line}</span>
        </span>
        <ChevronRight size={16} aria-hidden="true" className="work-chevron" />
      </button>
      {error && <p className="work-error" role="alert">{error}</p>}
    </li>
  );
}

/**
 * 맡긴 일: what is still going on first, then what the user asked for, by day.
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
        <p className="work-empty">아직 맡긴 일이 없어요.</p>
      ) : (
        <>
          {active.length > 0 && (
            <section className="work-section" aria-labelledby="work-active">
              <h2 id="work-active" className="work-label">하고 있는 일</h2>
              <ul className="work-list">
                {active.map(task => { const s = liveStatus(task); return <TaskRow key={task.id} task={task} line={s.text} tone={s.tone} destination="request" onOpen={onOpen} />; })}
              </ul>
            </section>
          )}
          {/* What the user asked for, by day. The assistant's own runs (watches, drafts, briefs) are not shown: their results arrive as messages. */}
          {days.map(({ day, requests }) => requests.length > 0 && (
            <section key={day} className="work-section" aria-labelledby={`work-day-${day}`}>
              <h2 id={`work-day-${day}`} className="work-label">{dayLabel(day, now)}</h2>
              <ul className="work-list">
                {requests.map(task => {
                  const s = finishedStatus(task);
                  return <TaskRow key={task.id} task={task} line={s.text} tone={s.failed ? 'failed' : 'done'}
                    destination={task.state === 'succeeded' ? 'reply' : 'request'} onOpen={onOpen} />;
                })}
              </ul>
            </section>
          ))}
          {more && <button type="button" className="work-more" onClick={() => setLimit(l => l + PAGE)}>더 보기</button>}
        </>
      )}
    </section>
  );
}
