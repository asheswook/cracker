import type { Task } from './types';
import { readableTitle } from './background-message';
import { taskReason } from './task-reason';

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
const elapsed = (from: string, now: Date) => {
  const minutes = Math.max(0, Math.floor((now.getTime() - Date.parse(from)) / 60_000));
  if (minutes < 1) return '방금 시작';
  if (minutes < 60) return `${minutes}분째`;
  const hours = Math.floor(minutes / 60);
  return hours < 24 ? `${hours}시간째` : `${Math.floor(hours / 24)}일째`;
};
/** The live line of a running task. */
export function liveStatus(task: Task, now: Date): { text: string; tone: 'live' | 'wait' | 'attention' } {
  switch (task.state) {
    case 'running': return { text: `진행 중 · ${elapsed(task.created_at, now)}`, tone: 'live' };
    case 'queued': return { text: '차례를 기다려요', tone: 'wait' };
    case 'waiting': return { text: '응답을 기다려요', tone: 'wait' };
    case 'pausing': return { text: '멈추는 중', tone: 'wait' };
    case 'paused': return { text: '잠시 멈춤', tone: 'wait' };
    case 'cancelling': return { text: '취소하는 중', tone: 'wait' };
    default: return { text: taskReason(task.reason)?.text ? `확인 필요 · ${taskReason(task.reason)!.text}` : '확인 필요', tone: 'attention' };
  }
}
/** The muted line of a finished task. */
export function finishedStatus(task: Task): { text: string; failed: boolean } {
  const at = clock.format(new Date(task.updated_at));
  if (task.state === 'succeeded') return { text: `완료 · ${at}`, failed: false };
  const reason = taskReason(task.reason)?.text;
  if (task.state === 'unknown') return { text: `결과 확인 못 함 · ${at}`, failed: true };
  if (task.state === 'cancelled') return { text: `취소 · ${at}${reason ? ` · ${reason}` : ''}`, failed: false };
  return { text: `실패 · ${at}${reason ? ` · ${reason}` : ''}`, failed: true };
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
/** Still going on: an automatic run whose outcome went unknown a day ago is history, not current work. */
const isActive = (t: Task) => activeStates.has(t.state) && !(t.state === 'unknown' && isRoutine(t) && Date.now() - Date.parse(t.updated_at) > 86_400_000);
export const activeTasks = (tasks: readonly Task[]) => tasks.filter(isActive).sort(byNewest('created_at'));
