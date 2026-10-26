import { useEffect, useLayoutEffect, useRef, useState } from 'react';
import { z } from 'zod';
import { CalendarClock, Repeat2 } from 'lucide-react';
import { errorMessage, read } from './api';
import type { useClient } from './store';
import { ErrorNotice } from './primitives';
import { WorkNavigationError } from './WorkOpenAction';
import { Id, Task } from './types';
import { scheduleTitle, spokenTime, whenLabel } from './schedule-labels';
import './schedules.css';
import { LoadingSkeleton } from './LoadingSkeleton';

const Responsibility = z.object({
  id: Id, objective: z.string(), title: z.string().nullable().optional(), until_at: z.string().nullable().optional(),
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
/** The last day, as people say it: "금요일", or "11월 3일" when it is more than a week away. */
function untilLabel(iso: string) {
  const d = new Date(iso), days = (d.getTime() - Date.now()) / 86_400_000;
  return days >= 0 && days < 7 ? new Intl.DateTimeFormat('ko-KR', { weekday: 'long' }).format(d) : new Intl.DateTimeFormat('ko-KR', { month: 'long', day: 'numeric' }).format(d);
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
/** Where the list was scrolled when the user left for a conversation, so coming back to 예약 lands in the same place. */
const memory = { scrollTop: 0 };

/**
 * One row: what it is and when it happens. Tapping it goes back to where the user asked for it (if that message is
 * known). Changing or stopping it is said to the assistant in words, not done with buttons here.
 */
function ScheduleRow({ icon: Icon, title, when, note, conversation, message, onSource }: {
  readonly icon: typeof Repeat2;
  readonly title: string;
  readonly when: React.ReactNode;
  readonly note: string | null;
  readonly conversation: string | null | undefined;
  readonly message: string | null | undefined;
  readonly onSource: ((conversation: Id, message: Id) => Promise<void> | void) | undefined;
}) {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const mounted = useRef(true);
  useEffect(() => { mounted.current = true; return () => { mounted.current = false; }; }, []);
  const target = onSource && conversation && message ? { conversation: Id.parse(conversation), message: Id.parse(message) } : null;
  const go = async () => {
    if (!target || !onSource) return;
    setBusy(true); setError('');
    try { await onSource(target.conversation, target.message); }
    catch (e) { if (mounted.current) setError(e instanceof WorkNavigationError ? e.message : errorMessage(e)); }
    finally { if (mounted.current) setBusy(false); }
  };
  const content = <>
    <span className="schedule-mark" aria-hidden="true"><Icon size={16} strokeWidth={1.9} /></span>
    <span className="schedule-text">
      <span className="schedule-title">{title}</span>
      <span className="schedule-when">{when}</span>
      {note && <span className="schedule-failed">{note}</span>}
    </span>
  </>;
  return <li className="schedule-row">
    {target
      ? <button type="button" className="schedule-main" onClick={() => void go()} aria-busy={busy || undefined} aria-description="원래 부탁 보기">{content}</button>
      : <div className="schedule-main" data-static="">{content}</div>}
    {error && <p className="schedule-error" role="alert">{error}</p>}
  </li>;
}

export function SchedulesPanel({ state, onSource }: {
  state: ReturnType<typeof useClient>;
  onSource?: ((conversation: Id, message: Id) => Promise<void> | void) | undefined;
}) {
  const [items, setItems] = useState<z.infer<typeof Responsibility>[]>([]);
  const [loaded, setLoaded] = useState(false);
  const [loadError, setLoadError] = useState('');
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
  }, []);
  useLayoutEffect(() => {
    const owner = section.current?.closest('.inspector-body');
    if (!loaded || restored.current || !(owner instanceof HTMLElement)) return;
    restored.current = true;
    owner.scrollTop = memory.scrollTop;
    const frame = requestAnimationFrame(() => { owner.scrollTop = memory.scrollTop; });
    return () => cancelAnimationFrame(frame);
  }, [loaded]);
  // Only what is still ahead. Finished and cancelled ones are gone; their results live in the conversation.
  const routines = items.filter(item => item.state === 'active');
  const upcoming = state.schedules.filter(item => item.status === 'pending').sort((a, b) => Date.parse(a.due_at) - Date.parse(b.due_at));
  const routineRow = (item: z.infer<typeof Responsibility>) => (
    // The rule says when ("매일 낮 12:00", "기한 내일 18:00까지"); the next run is never a mystery worth a line.
    <ScheduleRow key={item.id} icon={Repeat2} title={scheduleTitle(item)} when={item.until_at ? `${triggerLabel(item.trigger)} · ${untilLabel(item.until_at)}까지` : triggerLabel(item.trigger)}
      note={item.last_action?.task?.state === 'failed' ? '지난번엔 못 했어요' : null}
      conversation={item.conversation_id} message={item.source_message_id} onSource={onSource} />
  );
  const onceRow = (item: (typeof state.schedules)[number]) => (
    <ScheduleRow key={item.id} icon={CalendarClock} title={scheduleTitle(item)}
      when={<><time dateTime={item.due_at}>{whenLabel(item.due_at, item.timezone)}</time>{zoneSuffix(item.timezone)}</>} note={null}
      conversation={item.conversation_id} message={item.source_message_id} onSource={onSource} />
  );

  return (
    <section className="schedules-panel schedules-v2" aria-label="예약된 일" ref={section}>
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
