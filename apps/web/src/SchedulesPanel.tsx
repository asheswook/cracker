import { useEffect, useState } from 'react';
import { z } from 'zod';
import { ArrowUpRight, CalendarClock, CalendarDays, ChevronDown, ChevronRight, History, Plus, Repeat2 } from 'lucide-react';
import { errorMessage, read } from './api';
import { client, useClient } from './store';
import { Button, Empty, ErrorNotice, IconButton } from './primitives';
import { ScheduleForm } from './ScheduleForm';
import { ScheduleObjective } from './ScheduleObjective';
import { ScheduleHistory } from './ScheduleHistory';
import { Id, Task } from './types';
import { lastRunLabel, scheduleTitle, spokenTime, whenLabel } from './schedule-labels';
import './schedules.css';
import { LoadingSkeleton } from './LoadingSkeleton';

const Responsibility = z.object({
  id: Id, objective: z.string(), title: z.string().nullable().optional(), state: z.enum(['active', 'complete', 'cancelled']),
  trigger: z.discriminatedUnion('kind', [
    z.object({ kind: z.literal('daily'), hour: z.number(), minute: z.number(), timezone: z.string() }),
    z.object({ kind: z.literal('periodic'), interval_minutes: z.number() }),
    z.object({ kind: z.literal('deadline'), due_at: z.string(), timezone: z.string() }),
    z.object({ kind: z.literal('task_change'), task_id: Id }),
  ]),
  next_review_at: z.string(), last_error: z.string().nullable(),
  last_action: z.object({ state: z.string(), task: Task.nullable() }).nullable(),
  skill_id: Id.nullable().optional(), skill_revision: z.coerce.number().int().positive().nullable().optional(),
});
const Response = z.object({ responsibilities: Responsibility.array() });
const taskLabels: Readonly<Record<string, string>> = {
  queued: '대기 중', running: '진행 중', waiting: '응답 대기', pausing: '일시 정지 중',
  paused: '일시 정지', cancelling: '중지 확인 중', cancelled: '취소됨', succeeded: '완료',
  failed: '실패', unknown: '확인 필요',
};
const localZone = Intl.DateTimeFormat().resolvedOptions().timeZone;
function zoneSuffix(timezone: string) {
  if (timezone === localZone) return '';
  const city = timezone.split('/').at(-1)?.replaceAll('_', ' ') ?? timezone;
  return ` · ${city} 기준`;
}
function triggerLabel(trigger: z.infer<typeof Responsibility>['trigger']) {
  switch (trigger.kind) {
    case 'daily': {
      return `매일 ${spokenTime(trigger.hour, trigger.minute)}${zoneSuffix(trigger.timezone)}`;
    }
    case 'deadline': return `기한 ${whenLabel(trigger.due_at, trigger.timezone)}까지 챙기기${zoneSuffix(trigger.timezone)}`;
    case 'task_change': return '작업 상태가 바뀔 때';
    case 'periodic': return trigger.interval_minutes % 1440 === 0 ? `${trigger.interval_minutes / 1440}일마다` : trigger.interval_minutes % 60 === 0 ? `${trigger.interval_minutes / 60}시간마다` : `${trigger.interval_minutes}분마다`;
  }
}
export function SchedulesPanel({ state, onTask }: {
  state: ReturnType<typeof useClient>; onTask: (task: Task) => void;
}) {
  const [items, setItems] = useState<z.infer<typeof Responsibility>[]>([]);
  const [loaded, setLoaded] = useState(false);
  const [loadError, setLoadError] = useState('');
  const [actionError, setActionError] = useState('');
  const [refresh, setRefresh] = useState(0);
  const [scheduling, setScheduling] = useState(false);
  const [open, setOpen] = useState<string | null>(null);
  const [busy, setBusy] = useState<string | null>(null);
  const [history, setHistory] = useState<string | null>(null);
  useEffect(() => {
    let active = true;
    let timer: ReturnType<typeof setTimeout>;
    const load = async () => {
      try {
        const result = await read('/v1/responsibilities', Response);
        if (active) { setItems(result.responsibilities); setLoaded(true); setLoadError(''); }
      } catch (error) {
        if (active) setLoadError(errorMessage(error));
      } finally {
        if (active) timer = setTimeout(() => void load(), 5000);
      }
    };
    void load();
    return () => { active = false; clearTimeout(timer); };
  }, [refresh]);
  const cancel = async (id: string, resource: 'responsibilities' | 'schedules') => {
    setBusy(id); setActionError('');
    try {
      await client.action(`/v1/${resource}/${id}`, {}, 'delete');
      setRefresh(value => value + 1);
    } catch (error) { setActionError(errorMessage(error)); }
    finally { setBusy(null); }
  };
  type Routine = z.infer<typeof Responsibility>;
  const routines = items.filter(item => item.state === 'active');
  const upcoming = state.schedules.filter(item => item.status === 'pending').sort((a, b) => Date.parse(a.due_at) - Date.parse(b.due_at));
  const pastRoutines = items.filter(item => item.state !== 'active');
  const pastOnce = state.schedules.filter(item => item.status !== 'pending').sort((a, b) => Date.parse(b.due_at) - Date.parse(a.due_at));
  const pastCount = pastRoutines.length + pastOnce.length;
  const toggle = (id: string) => setOpen(value => (value === id ? null : id));
  const skillNote = (item: { skill_id?: string | null | undefined; skill_revision?: number | null | undefined }) =>
    item.skill_id && item.skill_revision ? <p className="field-help">스킬 버전 {item.skill_revision} 고정 · 최신 버전을 자동으로 따라가지 않아요.</p> : null;

  // One row per routine: what it is, when it runs, how it went last time. The details open in place.
  const routineRow = (item: Routine) => {
    const trigger = item.trigger;
    const timezone = trigger.kind === 'daily' || trigger.kind === 'deadline' ? trigger.timezone : undefined;
    const task = item.last_action?.task;
    const last = lastRunLabel(task, item.last_error);
    const expanded = open === item.id;
    const status = item.state === 'active'
      ? [item.last_action?.state === 'pending' ? '앞선 작업이 끝나면 시작해요' : `다음 · ${whenLabel(item.next_review_at, timezone)}`, last && !last.failed ? last.text : null].filter(Boolean).join(' · ')
      : item.state === 'complete' ? '끝남' : '그만둠';
    const title = scheduleTitle(item);
    return <li className="schedule-row" key={item.id} data-open={expanded || undefined}>
      <button type="button" className="schedule-main" aria-expanded={expanded} onClick={() => toggle(item.id)}>
        <span className="schedule-mark" aria-hidden="true"><Repeat2 size={16} strokeWidth={1.9} /></span>
        <span className="schedule-text">
          <span className="schedule-title">{title}</span>
          <span className="schedule-when">{triggerLabel(trigger)}</span>
          <span className="schedule-status">{status}</span>
          {last?.failed && <span className="schedule-failed">{last.text}</span>}
        </span>
        <ChevronDown size={16} aria-hidden="true" className="schedule-chevron" />
      </button>
      {expanded && <div className="schedule-detail" id={`schedule-detail-${item.id}`}>
        <div className="schedule-instructions"><p className="schedule-detail-label">맡긴 내용</p><ScheduleObjective objective={item.objective} /></div>
        {skillNote(item)}
        <div className="schedule-actions">
          {task && <button type="button" onClick={() => onTask(task)}><ArrowUpRight size={14} aria-hidden="true" />최근 실행 보기</button>}
          <button type="button" aria-expanded={history === item.id} aria-controls={`schedule-history-${item.id}`} onClick={() => setHistory(value => value === item.id ? null : item.id)}><History size={14} aria-hidden="true" />{history === item.id ? '실행 기록 접기' : '실행 기록'}</button>
          {item.state === 'active' && <Button className="schedule-stop" busy={busy === item.id} onClick={() => void cancel(item.id, 'responsibilities')}>그만하기</Button>}
        </div>
        {history === item.id && <div id={`schedule-history-${item.id}`}><ScheduleHistory key={item.id} responsibility={item.id} timezone={timezone} onTask={onTask} /></div>}
      </div>}
    </li>;
  };
  const onceRow = (item: (typeof state.schedules)[number]) => {
    const expanded = open === item.id;
    const status = item.task ? (taskLabels[item.task.state] ?? '상태 확인 중') : item.status === 'pending' ? null : item.status === 'cancelled' ? '취소됨' : '전달됨';
    const failed = item.task?.state === 'failed' || item.task?.state === 'unknown';
    return <li className="schedule-row" key={item.id} data-open={expanded || undefined}>
      <button type="button" className="schedule-main" aria-expanded={expanded} onClick={() => toggle(item.id)}>
        <span className="schedule-mark" aria-hidden="true"><CalendarClock size={16} strokeWidth={1.9} /></span>
        <span className="schedule-text">
          <span className="schedule-title">{scheduleTitle(item)}</span>
          <span className="schedule-when"><time dateTime={item.due_at}>{whenLabel(item.due_at, item.timezone)}</time>{zoneSuffix(item.timezone)}</span>
          {status && (failed ? <span className="schedule-failed">{status}</span> : <span className="schedule-status">{status}</span>)}
        </span>
        <ChevronDown size={16} aria-hidden="true" className="schedule-chevron" />
      </button>
      {expanded && <div className="schedule-detail">
        <div className="schedule-instructions"><p className="schedule-detail-label">맡긴 내용</p><ScheduleObjective objective={item.objective} /></div>
        {skillNote(item)}
        <div className="schedule-actions">
          {item.task && <button type="button" onClick={() => { if (item.task) onTask(item.task); }}><ArrowUpRight size={14} aria-hidden="true" />실행 보기</button>}
          {item.status === 'pending' && <Button className="schedule-stop" busy={busy === item.id} onClick={() => void cancel(item.id, 'schedules')}>예약 취소</Button>}
        </div>
      </div>}
    </li>;
  };

  return (
    <section className="schedules-panel schedules-v2" aria-label="예약된 일">
      <div className="schedule-toolbar">
        <IconButton label="예약 추가" aria-expanded={scheduling} onClick={() => setScheduling(value => !value)}><Plus size={18} /></IconButton>
      </div>
      {scheduling && <ScheduleForm state={state} onDone={() => setScheduling(false)} />}
      {actionError && <ErrorNotice>{actionError}</ErrorNotice>}
      {loadError && <div><ErrorNotice>{loadError}</ErrorNotice><Button onClick={() => setRefresh(value => value + 1)}>다시 불러오기</Button></div>}
      {!loaded && !loadError && <LoadingSkeleton layout="cards" label="예약을 불러오는 중…" />}
      {loaded && routines.length === 0 && upcoming.length === 0 && pastCount === 0 && (
        <Empty icon={<CalendarDays size={24} />} title="예정된 일이 없어요">시간을 정해 두면 어시스턴트가 그때 일을 시작해요.</Empty>
      )}
      {loaded && (routines.length > 0 || upcoming.length > 0 || pastCount > 0) && <>
        <section className="schedule-section" aria-labelledby="schedule-repeat">
          <h2 id="schedule-repeat" className="schedule-label">반복{routines.length > 0 && <span className="schedule-count">{routines.length}</span>}</h2>
          {routines.length ? <ul className="schedule-list" role="list">{routines.map(routineRow)}</ul> : <p className="schedule-calm">반복해서 맡긴 일은 없어요.</p>}
        </section>
        <section className="schedule-section" aria-labelledby="schedule-upcoming">
          <h2 id="schedule-upcoming" className="schedule-label">예정{upcoming.length > 0 && <span className="schedule-count">{upcoming.length}</span>}</h2>
          {upcoming.length ? <ul className="schedule-list" role="list">{upcoming.map(onceRow)}</ul> : <p className="schedule-calm">예정된 일은 없어요.</p>}
        </section>
        {pastCount > 0 && <details className="schedule-past">
          <summary>
            <span className="schedule-mark" aria-hidden="true"><History size={16} strokeWidth={1.9} /></span>
            <span className="schedule-title">지난 일 {pastCount}개</span>
            <ChevronRight size={16} aria-hidden="true" className="schedule-chevron" />
          </summary>
          <ul className="schedule-list" role="list">{[...pastRoutines.map(routineRow), ...pastOnce.map(onceRow)]}</ul>
        </details>}
      </>}
    </section>
  );
}
