import type { Task } from './types';
import { readableTitle } from './background-message';

export const activeStates = new Set(['queued', 'running', 'waiting', 'pausing', 'paused', 'cancelling', 'unknown']);

/** Runs the assistant starts on its own (watches, drafts, sends, checks, briefs, long routine instructions). */
const routinePrefix = /^\s*(?:예약된 작업 실행:\s*)?(?:(?:Gmail|Slack) observation|Prepare a reply draft|Send (?:exactly )?one approved|Check whether|Morning brief)/;
type TaskSummary = Pick<Task, 'objective' | 'title' | 'lane' | 'origin'>;
export const isRoutine = (task: TaskSummary): boolean => {
  if (task.lane !== undefined || task.origin !== undefined)
    return task.lane === 'background' || (task.origin !== undefined && task.origin !== 'user');
  const text = task.objective.trim();
  return routinePrefix.test(text) || /^\s*'[^']+'\s*스킬을/.test(text) || (text.length > 400 && /\n/.test(text));
};

const firstLine = (s: string) => s.split(/\r?\n/).map(l => l.trim()).find(Boolean) ?? '';
const clip = (s: string, max = 60) => (s.length > max ? `${s.slice(0, max - 1).trimEnd()}…` : s);
/** One readable line: routine runs by what they are, long instructions by their first sentence. */
export function taskTitle(task: TaskSummary): string {
  if (task.title?.trim()) return clip(task.title.trim());
  const line = firstLine(task.objective).replace(/^예약된 작업 실행:\s*/, '');
  if (isRoutine(task)) {
    const skill = /^\s*'([^']{1,50})'\s*스킬을/.exec(line)?.[1];
    if (skill) return clip(skill);
    const named = readableTitle(line);
    if (named !== line) return clip(named);
    const sentence = line.replace(/^\s*'[^']+'\s*스킬을\s*(?:먼저\s*)?로드해\s*(?:그\s*)?절차(?:대로)?\s*/, '').split(/(?<=[.!?。])\s|(?<=다\.)|(?<=요\.)/)[0] ?? line;
    return clip(sentence.trim() || '자동 작업');
  }
  // "<quoted answer> => <question>": the user's own words are after the arrow.
  const arrow = task.objective.lastIndexOf('=>');
  const own = arrow >= 40 ? firstLine(task.objective.slice(arrow + 2)) : '';
  return clip(own || line || '내용 없는 요청');
}

const clock = new Intl.DateTimeFormat('ko-KR', { hour: '2-digit', minute: '2-digit', hourCycle: 'h23' });
const dayName = new Intl.DateTimeFormat('ko-KR', { month: 'long', day: 'numeric' });
const dayNameYear = new Intl.DateTimeFormat('ko-KR', { year: 'numeric', month: 'long', day: 'numeric' });
export const startOfDay = (d: Date) => new Date(d.getFullYear(), d.getMonth(), d.getDate()).getTime();
export function dayLabel(day: number, now: Date): string {
  const days = Math.round((startOfDay(now) - day) / 86_400_000);
  if (days === 0) return '오늘';
  if (days === 1) return '어제';
  const d = new Date(day);
  return (d.getFullYear() === now.getFullYear() ? dayName : dayNameYear).format(d);
}
/** The line of something still going on: it is being done, or it stopped. Nothing about queues or runs. */
export function liveStatus(task: Task): { text: string; tone: 'live' | 'attention' } {
  return task.state === 'unknown' ? { text: '멈췄어요', tone: 'attention' } : { text: '하고 있어요', tone: 'live' };
}
/** The muted line of a finished request: when, and only if it did not work out, that it did not. */
export function finishedStatus(task: Task): { text: string; failed: boolean } {
  const at = clock.format(new Date(task.updated_at));
  if (task.state === 'succeeded' || task.state === 'cancelled') return { text: at, failed: false };
  return { text: `못 했어요 · ${at}`, failed: true };
}
const byNewest = (key: 'created_at' | 'updated_at') => (a: Task, b: Task) => Date.parse(b[key]) - Date.parse(a[key]);

export type FinishedDay = { day: number; requests: Task[]; routine: Task[] };
/** Finished work by day (of when it finished): the user's requests, and the assistant's own runs folded apart. */
export function finishedByDay(tasks: readonly Task[], limit: number): { days: FinishedDay[]; more: boolean } {
  const done = tasks.filter(t => !isActive(t)).sort(byNewest('updated_at'));
  const days: FinishedDay[] = [];
  let shown = 0, more = false;
  for (const task of done) {
    const routine = isRoutine(task);
    if (!routine && shown >= limit) { more = true; continue; }
    const day = startOfDay(new Date(task.updated_at));
    let group = days.find(d => d.day === day);
    if (!group) {
      // Days past the limit hold only routine runs; keep them out until 더 보기 too.
      if (shown >= limit) { more = true; continue; }
      group = { day, requests: [], routine: [] };
      days.push(group);
    }
    if (routine) group.routine.push(task); else { group.requests.push(task); shown++; }
  }
  return { days, more };
}
/** Still going on, among what the user asked for (the assistant's own runs report through messages). */
const isActive = (t: Task) => activeStates.has(t.state) && !isRoutine(t);
export const activeTasks = (tasks: readonly Task[]) => tasks.filter(isActive).sort(byNewest('created_at'));
