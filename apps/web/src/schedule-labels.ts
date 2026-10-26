import { taskReason } from './task-reason';

const startOfDay = (d: Date) => new Date(d.getFullYear(), d.getMonth(), d.getDate()).getTime();

/** "낮 12:00", "오전 9:30", "오후 3:00": a spoken-style clock. */
export function spokenTime(hour: number, minute: number): string {
  const part = hour === 0 ? '밤' : hour < 6 ? '새벽' : hour < 12 ? '오전' : hour === 12 ? '낮' : hour < 18 ? '오후' : '저녁';
  const h = hour % 12 === 0 ? 12 : hour % 12;
  return `${part} ${h}:${String(minute).padStart(2, '0')}`;
}
/** Wall-clock parts of an instant in a time zone (the device zone when none is given). */
function parts(iso: string, timezone?: string) {
  const d = new Date(iso);
  if (!timezone) return { y: d.getFullYear(), m: d.getMonth(), day: d.getDate(), hour: d.getHours(), minute: d.getMinutes() };
  const f = Object.fromEntries(new Intl.DateTimeFormat('en-US', { timeZone: timezone, year: 'numeric', month: 'numeric', day: 'numeric', hour: 'numeric', minute: 'numeric', hourCycle: 'h23' })
    .formatToParts(d).map(p => [p.type, p.value]));
  return { y: Number(f['year']), m: Number(f['month']) - 1, day: Number(f['day']), hour: Number(f['hour']), minute: Number(f['minute']) };
}
/** "오늘 16:40", "내일 10:00", "어제 09:00", else "10월 30일 10:00". */
export function whenLabel(iso: string, timezone?: string, now = new Date()): string {
  const p = parts(iso, timezone);
  const n = timezone ? parts(now.toISOString(), timezone) : parts(now.toISOString());
  const days = Math.round((startOfDay(new Date(p.y, p.m, p.day)) - startOfDay(new Date(n.y, n.m, n.day))) / 86_400_000);
  const clock = `${String(p.hour).padStart(2, '0')}:${String(p.minute).padStart(2, '0')}`;
  const day = days === 0 ? '오늘' : days === 1 ? '내일' : days === -1 ? '어제' : days === 2 ? '모레' : `${p.y !== n.y ? `${p.y}년 ` : ''}${p.m + 1}월 ${p.day}일`;
  return `${day} ${clock}`;
}
/** A title for a routine or schedule: the model's title, else the first sentence of the instructions. */
export function scheduleTitle(item: { readonly title?: string | null | undefined; readonly objective: string }): string {
  const title = item.title?.trim();
  if (title) return title;
  const line = item.objective.split(/\r?\n/).map(l => l.trim()).find(Boolean) ?? '';
  const cleaned = line.replace(/^\s*'[^']+'\s*스킬을\s*(?:먼저\s*)?로드해\s*(?:그\s*)?절차(?:대로)?\s*/, '').replace(/^예약된 작업 실행:\s*/, '');
  const sentence = (cleaned.split(/(?<=[.!?。])\s|(?<=다\.)|(?<=요\.)/)[0] ?? cleaned).trim() || '이름 없는 예약';
  return sentence.length > 50 ? `${sentence.slice(0, 49).trimEnd()}…` : sentence;
}
/** What happened last time, in a word (and why, when it failed). */
export function lastRunLabel(task: { readonly state: string; readonly reason: string | null } | null | undefined, lastError: string | null): { text: string; failed: boolean } | null {
  if (task?.state === 'unknown') return { text: '지난번 결과 확인 못 함', failed: true };
  if (task?.state === 'failed') return { text: `지난번 실패${taskReason(task.reason)?.text ? ` · ${taskReason(task.reason)!.text}` : ''}`, failed: true };
  if (lastError) return { text: `지난번 확인 실패${taskReason(lastError)?.text ? ` · ${taskReason(lastError)!.text}` : ''}`, failed: true };
  if (!task) return null;
  const word: Record<string, string> = { succeeded: '지난번 완료', cancelled: '지난번 취소됨', running: '지금 실행 중', queued: '실행 대기 중', waiting: '응답 기다리는 중', pausing: '멈추는 중', paused: '잠시 멈춤', cancelling: '취소하는 중' };
  return { text: word[task.state] ?? '상태 확인 중', failed: false };
}
