import { useEffect, useRef } from 'react';
import type { RefObject } from 'react';
import { TaskNavigation } from '../../../packages/protocol/task-navigation';
import { http } from './api';
import { client } from './store';
import { Id } from './types';
import type { Task } from './types';
import { WorkNavigationError } from './WorkOpenAction';

export type TaskDestination = 'request' | 'reply';
export function useWorkNavigation({ workspace, phase, panel, generation, onOpened }: {
  readonly workspace: Id | null;
  readonly phase: string;
  readonly panel: string | null;
  readonly generation: RefObject<number>;
  readonly onOpened: (conversation: Id, message: Id) => void;
}) {
  const pending = useRef<AbortController | null>(null);
  useEffect(() => () => { pending.current?.abort(); }, [workspace, phase, panel]);
  const open = async (resolve: (signal: AbortSignal) => Promise<{ readonly conversation: Id; readonly message: Id }>) => {
    pending.current?.abort();
    const controller = new AbortController();
    pending.current = controller;
    const version = ++generation.current;
    const current = () => !controller.signal.aborted && generation.current === version && client.snapshot().workspace === workspace;
    try {
      const target = await resolve(controller.signal);
      if (!current()) return;
      await client.select(target.conversation, target.message);
      if (!current() || client.snapshot().selected !== target.conversation) return;
      if (!client.snapshot().messages.some(message => message.id === target.message && message.conversation_id === target.conversation))
        throw new WorkNavigationError('메시지를 불러오지 못했어요. 다시 시도해 주세요.');
      onOpened(target.conversation, target.message);
    } catch (error) {
      if (current()) throw error;
    } finally { if (pending.current === controller) pending.current = null; }
  };
  return {
    openSource: (conversation: Id, message: Id) => open(async () => ({ conversation, message })),
    openTask: (task: Task, sourceMessageId?: Id, destination: TaskDestination = 'request') =>
      open(signal => taskTarget(task, sourceMessageId, destination, signal)),
  };
}

export async function taskTarget(task: Task, sourceMessageId: Id | undefined, destination: TaskDestination, signal?: AbortSignal) {
  if (sourceMessageId) return { conversation: task.conversation_id, message: sourceMessageId };
  const target = TaskNavigation.parse(await http.get(`/v1/tasks/${task.id}/navigation`, signal ? { signal } : {}).json<unknown>());
  if (target.task_id !== task.id || target.conversation_id !== task.conversation_id)
    throw new WorkNavigationError('작업의 메시지 정보를 확인할 수 없어요. 다시 시도해 주세요.');
  const message = destination === 'reply' ? target.reply_message_id ?? target.request_message_id : target.request_message_id;
  if (!message) throw new WorkNavigationError(destination === 'reply' ? '이 작업에 저장된 답변이 없어요. 요청 원문을 확인해 주세요.' : '이 작업에 저장된 요청 원문이 없어요.');
  return { conversation: Id.parse(target.conversation_id), message: Id.parse(message) };
}
