import { useEffect, useRef } from 'react';
import { errorToasts } from './error-toasts';
import { taskReason } from './task-reason';
import type { Task } from './types';

export function useTaskErrorToasts(workspace: string | null, ready: boolean, tasks: readonly Task[]) {
  const previous = useRef<Readonly<{ workspace: string; states: ReadonlyMap<string, string> }> | null>(null);
  useEffect(() => {
    if (!workspace) { if (previous.current) errorToasts.clear(); previous.current = null; return; }
    if (!ready) return;
    if (previous.current && previous.current.workspace !== workspace) errorToasts.clear();
    const signatures = new Map(tasks.map(task => [task.id, `${task.state}:${task.updated_at}:${task.reason ?? ''}`]));
    if (previous.current?.workspace === workspace) {
      for (const task of tasks) {
        if ((task.state === 'failed' || task.state === 'unknown') && task.reason?.trim()
          && previous.current.states.get(task.id) !== signatures.get(task.id)) {
          errorToasts.show(taskReason(task.reason)?.text ?? '', `task:${task.id}:${task.updated_at}`);
        }
      }
    }
    previous.current = { workspace, states: signatures };
  }, [workspace, ready, tasks]);
}
