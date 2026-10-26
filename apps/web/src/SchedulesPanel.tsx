import { useEffect, useLayoutEffect, useRef, useState } from 'react';
import { z } from 'zod';
import { CalendarClock, ChevronDown, Repeat2 } from 'lucide-react';
import { errorMessage, read } from './api';
import { client, useClient } from './store';
import { Button, ErrorNotice } from './primitives';
import { Id, Task } from './types';
import { scheduleTitle, spokenTime, whenLabel } from './schedule-labels';
import { OriginalAskLink } from './OriginalAsk';
import './schedules.css';
import { LoadingSkeleton } from './LoadingSkeleton';

const Responsibility = z.object({
  id: Id, objective: z.string(), title: z.string().nullable().optional(),
  conversation_id: Id.optional(), source_message_id: Id.nullable().optional(), state: z.enum(['active', 'complete', 'cancelled']),
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
    case 'task_change': return '맡긴 일이 끝나면';
    case 'periodic': return trigger.interval_minutes % 1440 === 0 ? `${trigger.interval_minutes / 1440}일마다` : trigger.interval_minutes % 60 === 0 ? `${trigger.interval_minutes / 60}시간마다` : `${trigger.interval_minutes}분마다`;
  }
}
/**
 * What was open, and where the list was scrolled, when the user left for a conversation ("원래 부탁 보기"), so coming back to 예약 lands in the same place. Lives for the page session, like work navigation.
 */
const memory = { open: null as string | null, scrollTop: 0 };

export function SchedulesPanel({ state, onSource }: {
  state: ReturnType<typeof useClient>; onTask: (task: Task) => void;
  onSource?: ((conversation: Id, message: Id) => Promise<void> | void) | undefined;
}) {
  const [items, setItems] = useState<z.infer<typeof Responsibility>[]>([]);
  const [loaded, setLoaded] = useState(false);
  const [loadError, setLoadError] = useState('');
  const [actionError, setActionError] = useState('');
  const [refresh, setRefresh] = useState(0);
  const [open, setOpenState] = useState<string | null>(memory.open);
  const [busy, setBusy] = useState<string | null>(null);
  const setOpen = (next: (value: string | null) => string | null) => setOpenState(value => (memory.open = next(value)));
  const section = useRef<HTMLElement>(null);
  // Scroll is restored once the list is there (the first load is async), then followed while reading.
  const restored = useRef(false);
  useLayoutEffect(() => {
    const owner = section.current?.closest('.inspector-body');
    if (!(owner instanceof HTMLElement)) return;
    const save = () => { if (restored.current) memory.scrollTop = owner.scrollTop; };
    owner.addEventListener('scroll', save, { passive: true });
    return () => owner.removeEventListener('scroll', save);
  }, []);
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
  useLayoutEffect(() => {
    const owner = section.current?.closest('.inspector-body');
    if (!loaded || restored.current || !(owner instanceof HTMLElement)) return;
    restored.current = true;
    owner.scrollTop = memory.scrollTop;
    const frame = requestAnimationFrame(() => { owner.scrollTop = memory.scrollTop; });
    return () => cancelAnimationFrame(frame);
  }, [loaded]);
  type Routine = z.infer<typeof Responsibility>;
  // Only what is still ahead. Finished and cancelled ones are gone; their results live in the conversation.
  const routines = items.filter(item => item.state === 'active');
  const upcoming = state.schedules.filter(item => item.status === 'pending').sort((a, b) => Date.parse(a.due_at) - Date.parse(b.due_at));
  const toggle = (id: string) => setOpen(value => (value === id ? null : id));

  // A row says what it is and when it happens next. Opened, it offers the one thing worth doing: stop it
  // (and a way back to where it was asked for).
  const row = (id: string, icon: typeof Repeat2, title: string, when: React.ReactNode, note: string | null, actions: React.ReactNode) => {
    const Icon = icon;
    const expanded = open === id;
    return <li className="schedule-row" key={id} data-open={expanded || undefined}>
      <button type="button" className="schedule-main" aria-expanded={expanded} onClick={() => toggle(id)}>
        <span className="schedule-mark" aria-hidden="true"><Icon size={16} strokeWidth={1.9} /></span>
        <span className="schedule-text">
          <span className="schedule-title">{title}</span>
          <span className="schedule-when">{when}</span>
          {note && <span className="schedule-failed">{note}</span>}
        </span>
        <ChevronDown size={16} aria-hidden="true" className="schedule-chevron" />
      </button>
      {expanded && <div className="schedule-detail"><div className="schedule-actions">{actions}</div></div>}
    </li>;
  };
  const routineRow = (item: Routine) => {
    const trigger = item.trigger;
    const failed = item.last_action?.task?.state === 'failed';
    return row(item.id, Repeat2, scheduleTitle(item),
      // The rule says when ("매일 낮 12:00", "기한 내일 18:00까지"); the next run is never a mystery worth a line.
      <>{triggerLabel(trigger)}</>,
      failed ? '지난번엔 못 했어요' : null,
      <>
        <OriginalAskLink conversation={item.conversation_id} message={item.source_message_id} onOpen={onSource} />
        <Button className="schedule-stop" busy={busy === item.id} onClick={() => void cancel(item.id, 'responsibilities')}>그만하기</Button>
      </>);
  };
  const onceRow = (item: (typeof state.schedules)[number]) => row(item.id, CalendarClock, scheduleTitle(item),
    <><time dateTime={item.due_at}>{whenLabel(item.due_at, item.timezone)}</time>{zoneSuffix(item.timezone)}</>, null,
    <>
      <OriginalAskLink conversation={item.conversation_id} message={item.source_message_id} onOpen={onSource} />
      <Button className="schedule-stop" busy={busy === item.id} onClick={() => void cancel(item.id, 'schedules')}>취소하기</Button>
    </>);

  return (
    <section className="schedules-panel schedules-v2" aria-label="예약된 일" ref={section}>
      {actionError && <ErrorNotice>{actionError}</ErrorNotice>}
      {loadError && <ErrorNotice>{loadError}</ErrorNotice>}
      {!loaded && !loadError && <LoadingSkeleton layout="cards" label="불러오는 중…" />}
      {loaded && !routines.length && !upcoming.length && <p className="schedule-empty">예약된 일이 없어요.</p>}
      {/* Headings only when there is something to tell apart. */}
      {routines.length > 0 && (
        <section className="schedule-section" aria-labelledby={upcoming.length ? 'schedule-repeat' : undefined} aria-label={upcoming.length ? undefined : '반복'}>
          {upcoming.length > 0 && <h2 id="schedule-repeat" className="schedule-label">반복</h2>}
          <ul className="schedule-list" role="list">{routines.map(routineRow)}</ul>
        </section>
      )}
      {upcoming.length > 0 && (
        <section className="schedule-section" aria-labelledby={routines.length ? 'schedule-upcoming' : undefined} aria-label={routines.length ? undefined : '예정'}>
          {routines.length > 0 && <h2 id="schedule-upcoming" className="schedule-label">예정</h2>}
          <ul className="schedule-list" role="list">{upcoming.map(onceRow)}</ul>
        </section>
      )}
    </section>
  );
}
