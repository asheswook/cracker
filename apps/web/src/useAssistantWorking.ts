import { useCallback, useSyncExternalStore } from 'react';
import type { AssistantWorking, Id, Message, Pending, Task } from './types';

type WorkingContext = Readonly<{
  phase: 'loading' | 'login' | 'ready';
  connected: boolean;
  selected: Id | null;
  assistantId: Id | null;
  working: AssistantWorking | null;
  tasks: readonly Task[];
  messages: readonly Message[];
  outbox: readonly Pending[];
}>;

export function assistantWorking(context: WorkingContext, now: number): boolean {
  const { working, selected } = context;
  if (context.phase !== 'ready' || !context.connected || !selected || selected !== context.assistantId ||
      !working || Date.parse(working.expires_at) <= now ||
      context.outbox.some(message => message.conversation_id === selected)) return false;
  const task = context.tasks.find(candidate => candidate.id === working.task_id);
  const latestUser = context.messages.reduce<Message | undefined>((latest, message) =>
    message.role === 'user' && (!latest || message.sequence > latest.sequence) ? message : latest, undefined);
  return task?.state === 'running' && task.conversation_id === selected &&
    latestUser?.conversation_id === selected && latestUser.id === working.input_message_id && Boolean(latestUser.read_at);
}

export function useAssistantWorking(context: WorkingContext): boolean {
  const expires = assistantWorking(context, Date.now()) && context.working ? Date.parse(context.working.expires_at) : null;
  const subscribe = useCallback((changed: () => void) => {
    if (expires === null || expires <= Date.now()) return () => {};
    const timer = setTimeout(changed, expires - Date.now());
    return () => clearTimeout(timer);
  }, [expires]);
  return useSyncExternalStore(subscribe, () => assistantWorking(context, Date.now()), () => false);
}
