import { z } from 'zod';
import { Id, Task } from '../types';

export const SkillVersion = z.object({
  skill_id: Id,
  revision: z.coerce.number().int().positive(),
  name: z.string(),
  description: z.string(),
  content: z.string(),
  content_hash: z.string(),
  origin_message_id: Id.nullable(),
  created_at: z.string(),
});
export type SkillVersion = z.infer<typeof SkillVersion>;
export const VersionPage = z.object({
  versions: SkillVersion.array(),
  next_revision: z.coerce.number().nullable(),
});
export const ExecutionCheck = z.object({
  id: Id,
  criterion: z.string(),
  observed: z.string(),
  status: z.enum(['pass', 'fail', 'unknown']),
  source_message_id: Id,
  actor: z.literal('user'),
  created_at: z.string(),
});
export const SkillExecution = z.object({
  id: Id,
  revision: z.coerce.number(),
  kind: z.enum(['test', 'scheduled']),
  created_at: z.string(),
  task: Task,
  conversation_id: Id,
  input_message_id: Id,
  loaded_at: z.string().nullable(),
  loaded_run_id: Id.nullable(),
  result_message_id: Id.nullable(),
  checks: ExecutionCheck.array(),
});
export type SkillExecution = z.infer<typeof SkillExecution>;
export const ExecutionPage = z.object({ executions: SkillExecution.array(), next_cursor: Id.nullable() });
export const TestStarted = z.object({ execution_id: Id, conversation_id: Id, task: Task });
export function resultUrl(conversation: string, message: string) {
  return `/?conversation=${encodeURIComponent(conversation)}&message=${encodeURIComponent(message)}`;
}
export const executionState: Readonly<Record<string, string>> = {
  queued: '실행 대기',
  running: '실행 중',
  waiting: '응답 대기',
  pausing: '일시 정지 중',
  paused: '일시 정지',
  cancelling: '중지 확인 중',
  cancelled: '취소됨',
  succeeded: '실행 종료',
  failed: '실행 실패',
  unknown: '실행 결과 확인 필요',
};
export const checkState = { pass: '근거 확인', fail: '불일치', unknown: '확인 불가' } as const;
