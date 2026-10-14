import { useEffect, useState } from 'react';
import { z } from 'zod';
import { ArrowUpRight, CalendarDays, Plus, Repeat2 } from 'lucide-react';
import { errorMessage, read } from './api';
import { client, useClient } from './store';
import { Button, Empty, ErrorNotice, IconButton } from './primitives';
import { ScheduleForm } from './ScheduleForm';
import { ScheduleObjective } from './ScheduleObjective';
import { ScheduleHistory } from './ScheduleHistory';
import { Id, Task } from './types';
import './schedules.css';

const Responsibility = z.object({
  id: Id, objective: z.string(), state: z.enum(['active', 'complete', 'cancelled']),
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
function dateLabel(date: string, timezone?: string) {
  return new Date(date).toLocaleString('ko-KR', {
    timeZone: timezone, month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit',
  });
}
function triggerLabel(trigger: z.infer<typeof Responsibility>['trigger']) {
  switch (trigger.kind) {
    case 'daily': return `매일 ${String(trigger.hour).padStart(2, '0')}:${String(trigger.minute).padStart(2, '0')} · ${trigger.timezone}`;
    case 'deadline': return `기한 확인 · ${trigger.timezone}`;
    case 'task_change': return '작업 상태가 바뀔 때';
    case 'periodic': return '정기적으로 상황 점검';
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
  const [past, setPast] = useState(false);
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
  const recurring = items.filter(item => past ? item.state !== 'active' : item.state === 'active');
  const once = state.schedules
    .filter(item => past ? item.status !== 'pending' : item.status === 'pending')
    .sort((left, right) => {
      const difference = Date.parse(left.due_at) - Date.parse(right.due_at);
      return past ? -difference : difference;
    });
  return (
    <section className="schedules-panel" aria-label="예약된 일">
      <div className="panel-toolbar">
        <div className="work-filters segmented" role="group" aria-label="예약 보기">
          <button type="button" aria-pressed={!past} onClick={() => setPast(false)}>예정</button>
          <button type="button" aria-pressed={past} onClick={() => setPast(true)}>지난 일</button>
        </div>
        <IconButton label="예약 추가" aria-expanded={scheduling} onClick={() => setScheduling(value => !value)}><Plus size={18} /></IconButton>
      </div>
      {scheduling && <ScheduleForm state={state} onDone={() => setScheduling(false)} />}
      {actionError && <ErrorNotice>{actionError}</ErrorNotice>}
      {loadError && <div><ErrorNotice>{loadError}</ErrorNotice><Button onClick={() => setRefresh(value => value + 1)}>다시 불러오기</Button></div>}
      {!loaded && !loadError && <p className="field-help">예약을 불러오는 중…</p>}
      {loaded && recurring.length === 0 && once.length === 0 && (
        <Empty icon={<CalendarDays size={24} />} title={past ? '지난 예약이 없어요' : '예정된 일이 없어요'}>
          {past ? '실행하거나 취소한 예약을 여기서 볼 수 있어요.' : '시간을 정해 두면 어시스턴트가 그때 일을 시작해요.'}
        </Empty>
      )}
      {recurring.length > 0 && <>
        <h2 className="schedule-section-title">계속 맡긴 일</h2>
        <ul className="resource-list schedule-list" role="list">
          {recurring.map(item => {
            const trigger = item.trigger;
            const timezone = trigger.kind === 'daily' || trigger.kind === 'deadline' ? trigger.timezone : undefined;
            const task = item.last_action?.task;
            return <li className="resource-item" key={item.id}>
              <div className="resource-meta"><span><Repeat2 size={13} />{triggerLabel(trigger)}</span></div>
              <ScheduleObjective objective={item.objective} />
              {item.skill_id&&item.skill_revision&&<p className="field-help">스킬 버전 {item.skill_revision} 고정 · 최신 버전을 자동으로 따라가지 않아요.</p>}
              {item.state === 'active' ? <p className="schedule-next">{trigger.kind === 'daily' ? '다음 실행' : '다음 확인'} <time dateTime={item.next_review_at}>{dateLabel(item.next_review_at, timezone)}</time></p> : <p>{item.state === 'complete' ? '종료됨' : '취소됨'}</p>}
              {item.last_action?.state === 'pending' && <p>앞선 작업이 끝나면 시작해요.</p>}
              {task && <p>최근 실행 · {taskLabels[task.state] ?? '상태 확인 중'}</p>}
              {item.last_error && <p className="schedule-error">최근 확인에 실패했어요.</p>}
              <div className="work-actions">
                {task && <Button className="small-button" onClick={() => onTask(task)}><ArrowUpRight size={13} />최근 실행 보기</Button>}
                <Button className="small-button" aria-expanded={history === item.id} aria-controls={`schedule-history-${item.id}`} onClick={() => setHistory(value => value === item.id ? null : item.id)}>{history === item.id ? '실행 기록 접기' : '실행 기록'}</Button>
                {item.state === 'active' && <Button className="small-button" busy={busy === item.id} onClick={() => void cancel(item.id, 'responsibilities')}>앞으로의 예약 취소</Button>}
              </div>
              {history === item.id && <div id={`schedule-history-${item.id}`}><ScheduleHistory key={item.id} responsibility={item.id} timezone={timezone} onTask={onTask} /></div>}
            </li>;
          })}
        </ul>
      </>}
      {once.length > 0 && <>
        <h2 className="schedule-section-title">한 번 맡긴 일</h2>
        <ul className="resource-list schedule-list" role="list">
          {once.map(item => <li className="resource-item" key={item.id}>
            <div className="resource-meta"><time dateTime={item.due_at}>{dateLabel(item.due_at, item.timezone)}</time><span>{item.task ? taskLabels[item.task.state] : item.status === 'pending' ? '예약됨' : item.status === 'cancelled' ? '취소됨' : '전달됨'}</span></div>
            <ScheduleObjective objective={item.objective} /><p className="field-help">{item.timezone}</p>
            {item.skill_id&&item.skill_revision&&<p className="field-help">스킬 버전 {item.skill_revision} 고정 · 최신 버전을 자동으로 따라가지 않아요.</p>}
            <div className="work-actions">
              {item.task && <Button className="small-button" onClick={() => { if (item.task) onTask(item.task); }}><ArrowUpRight size={13} />실행 보기</Button>}
              {item.status === 'pending' && <Button className="small-button" busy={busy === item.id} onClick={() => void cancel(item.id, 'schedules')}>예약 취소</Button>}
            </div>
          </li>)}
        </ul>
      </>}
    </section>
  );
}
