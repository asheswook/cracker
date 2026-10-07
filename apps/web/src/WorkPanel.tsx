import { useLayoutEffect, useRef, useState } from 'react';
import { ListChecks } from 'lucide-react';
import type { Id, Task } from './types';
import { Empty } from './primitives';
import { WorkSearch } from './WorkSearch';
import { compareNewestCreated } from './recent-order';
import { ScheduleObjective } from './ScheduleObjective';
import { TaskStatus } from './TaskStatus';
import { WorkOpenAction } from './WorkOpenAction';
import { createWorkSession } from './work-session';
import type { WorkFilter, WorkSession } from './work-session';
import type { TaskDestination } from './useWorkNavigation';
import './schedules.css';
import './work-search.css';
const activeStates = new Set(['queued', 'running', 'waiting', 'pausing', 'paused', 'cancelling', 'unknown']);
const labels: Readonly<Record<string, string>> = {
  queued: '대기 중',
  running: '진행 중',
  waiting: '응답 대기',
  pausing: '일시 정지 중',
  paused: '일시 정지',
  cancelling: '중지 확인 중',
  cancelled: '취소됨',
  succeeded: '완료',
  failed: '실패',
  unknown: '확인 필요',
};
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
  const [filter, setFilter] = useState<WorkFilter>(session.filter);
  const section = useRef<HTMLElement>(null);
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
  const results = tasks.filter(
    (task) =>
      (!query.trim() ||
        `${task.objective} ${task.reason ?? ''}`
          .toLocaleLowerCase()
          .includes(query.trim().toLocaleLowerCase())) &&
      (filter === 'all' ||
        (filter === 'active' ? activeStates.has(task.state) : !activeStates.has(task.state))),
  ).sort(compareNewestCreated);
  return (
    <section className="work-panel" aria-label="맡긴 일 찾기" ref={section}>
      <div className="work-tools">
        <input
          type="search"
          aria-label="작업 검색"
          placeholder="본문·파일·맡긴 일 검색"
          maxLength={200}
          value={query}
          onChange={(event) => { if (event.target.value.trim() !== query.trim()) resetReading(); session.query = event.target.value; setQuery(event.target.value); }}
        />
        <div className="work-filters" aria-label="작업 상태 필터">
          {[
            { id: 'all' as const, label: '전체' },
            { id: 'active' as const, label: '진행 중' },
            { id: 'finished' as const, label: '지난 일' },
          ].map((item) => (
            <button
              key={item.id}
              type="button"
              aria-pressed={filter === item.id}
              onClick={() => { if (item.id === filter) return; resetReading(); session.filter = item.id; setFilter(item.id); }}
            >
              {item.label}
            </button>
          ))}
        </div>
      </div>
      {query.trim() ? <WorkSearch key={`${query.trim()}:${filter}`} query={query} filter={filter} onSource={onSource} session={session}/> : results.length === 0 ? (
        <Empty
          icon={<ListChecks size={24} />}
          title={tasks.length ? '일치하는 일이 없어요' : '아직 맡긴 일이 없어요'}
        >
          {tasks.length
            ? '검색어나 상태 필터를 바꿔 보세요.'
            : '메시지로 일을 맡기면 진행 상황과 결과를 여기서 찾을 수 있어요.'}
        </Empty>
      ) : (
        <div className="resource-list">
          {results.map((task) => (
            <article className="resource-item" key={task.id} data-task-id={task.id}>
              <div className="resource-meta">
                <span className={`task-state ${task.state}`}>{labels[task.state] ?? task.state}</span>
                <time dateTime={task.created_at}>
                  {new Date(task.created_at).toLocaleDateString('ko-KR', { month: 'short', day: 'numeric' })}
                </time>
              </div>
              <ScheduleObjective objective={task.objective} open={session.disclosures.has(task.id)} onToggle={open => { if (open) session.disclosures.add(task.id); else session.disclosures.delete(task.id); }} />
              <TaskStatus task={task} />
              {task.reason && task.state !== 'failed' && task.state !== 'unknown' && <p>{task.reason}</p>}
              <div className="work-actions">
                {task.state === 'succeeded' && <WorkOpenAction onOpen={() => onOpen(task, undefined, 'reply')}>답변 보기</WorkOpenAction>}
                <WorkOpenAction onOpen={() => onOpen(task, undefined, 'request')}>요청 보기</WorkOpenAction>
              </div>
            </article>
          ))}
        </div>
      )}
    </section>
  );
}
