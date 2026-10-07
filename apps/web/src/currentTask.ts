import type { Id, Task } from './types';

export function currentTask(tasks: readonly Task[], conversation: Id | null): Task | undefined {
  let active: Task | undefined;
  let latest: Task | undefined;
  for (const task of tasks) {
    if (task.conversation_id !== conversation) continue;
    if (!latest || Date.parse(task.created_at) >= Date.parse(latest.created_at)) latest = task;
    if (
      !['succeeded', 'failed', 'cancelled'].includes(task.state) &&
      (!active || Date.parse(task.created_at) >= Date.parse(active.created_at))
    ) active = task;
  }
  return active ?? latest;
}
