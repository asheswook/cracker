import type { Message } from './types';
import { taskReason } from './task-reason';

const retiredTaskNotices = new Set([
  '작업 상태를 확인할 수 없어요. 다시 진행하기 전에 확인이 필요해요.',
  '실행 결과를 확인할 수 없어 자동으로 재실행하지 않았어요.',
]);

export function systemMessageContent(message: Message): string | null {
  if (message.role !== 'system') return message.content;
  if (message.task_status) return null;
  if (retiredTaskNotices.has(message.content.trim())) return null;
  if (!message.content.trim()) return '상태가 업데이트됐어요.';
  return /[가-힣]/.test(message.content) ? message.content : taskReason(message.content)?.text ?? message.content;
}
