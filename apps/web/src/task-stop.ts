import { useEffect, useRef, useState } from 'react';
import { HTTPError } from 'ky';
import { http, errorMessage } from './api';
import { client } from './store';
import type { Task } from './types';

/** States in which a task can still be stopped (the server refuses terminal ones). */
export const stoppable = (task: Pick<Task, 'state'>) => ['queued', 'running', 'waiting', 'pausing', 'paused', 'unknown'].includes(task.state);

/** POST /v1/tasks/:id/stop, with the two refusals said plainly; the task list refreshes either way. */
export async function stopTask(id: string): Promise<void> {
  try {
    await http.post(`/v1/tasks/${id}/stop`);
  } catch (error) {
    if (error instanceof HTTPError && error.response.status === 409) {
      const code = await error.response.clone().json().then((b: { error?: { code?: string } }) => b.error?.code, () => undefined);
      if (code === 'terminal_task') throw new Error('이미 끝난 일이에요.');
      if (code === 'not_assigned') throw new Error('아직 멈출 수 없어요. 잠시 후 다시 해 주세요.');
    }
    throw new Error(errorMessage(error));
  } finally { void client.refresh(); }
}

/**
 * Two taps to stop: the first asks ("멈출까요?"), the second stops. The question goes away on its own after a few
 * seconds, so a stray tap never leaves a loaded trigger behind.
 */
export function useStopConfirm(taskId: string | null) {
  const [asking, setAsking] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [sent, setSent] = useState<string | null>(null);
  const mounted = useRef(true);
  useEffect(() => { mounted.current = true; return () => { mounted.current = false; }; }, []);
  useEffect(() => { setAsking(false); setError(''); }, [taskId]);
  useEffect(() => {
    if (!asking) return;
    const timer = setTimeout(() => setAsking(false), 6000);
    return () => clearTimeout(timer);
  }, [asking]);
  const confirm = async () => {
    if (!taskId) return;
    setBusy(true); setError('');
    try { await stopTask(taskId); if (mounted.current) { setSent(taskId); setAsking(false); } }
    catch (e) { if (mounted.current) { setError(e instanceof Error ? e.message : errorMessage(e)); setAsking(false); } }
    finally { if (mounted.current) setBusy(false); }
  };
  return {
    asking, busy, error,
    /** True once a stop was accepted for this task, until the server reports the new state. */
    stopping: sent !== null && sent === taskId,
    ask: () => { setError(''); setAsking(true); },
    cancel: () => setAsking(false),
    confirm,
  };
}
