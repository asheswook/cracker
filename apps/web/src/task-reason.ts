export type TaskReason = Readonly<{ text: string; detail: string | null }>;

const known: readonly (readonly [RegExp, string])[] = [
  [/^Runtime\/provider\/tool failure/, '작업 중 문제가 생겨 멈췄어요. 메시지를 보내면 하던 곳부터 이어서 해요.'],
  [/^Unexpected runtime failure/, '작업 중 예상하지 못한 문제가 생겨 멈췄어요. 다시 요청해 주세요.'],
  [/^Control disconnected during execution/, '작업 중 연결이 끊겨 멈췄어요. 메시지를 보내면 하던 곳부터 이어서 해요.'],
  [/^Daemon restarted/, '어시스턴트 컴퓨터가 다시 시작돼 작업이 멈췄어요. 다시 요청해 주세요.'],
  [/^VM heartbeat expired/, '어시스턴트 컴퓨터와 연결이 끊겨 작업이 멈췄어요.'],
  [/^Checkpoint does not prove effect safety/, '중단된 작업을 안전하게 이어갈 수 없어 멈췄어요. 다시 요청해 주세요.'],
  [/^Takeover interrupted actions/, '직접 조작하는 동안 진행 중이던 작업이 멈췄어요. 다시 요청해 주세요.'],
  [/^Execution cleanup failed|cleanup fail/i, '작업을 정리하는 중 문제가 생겼어요. 다시 요청해 주세요.'],
  [/^Desktop (execution|session)/, '컴퓨터 화면 작업 중 문제가 생겨 멈췄어요. 다시 요청해 주세요.'],
  [/^Invalid provider response/, '모델 응답을 처리하지 못해 멈췄어요. 실행된 동작은 없어요. 메시지를 보내면 이어서 해요.'],
  [/^Future work operation could not be confirmed/, '예약 작업을 저장했는지 확인하지 못했어요. 예약 목록을 확인해 주세요.'],
  [/^Attachment or generated file operation failed/, '파일을 처리하지 못해 멈췄어요. 다시 요청해 주세요.'],
  [/^Provider declined this task/, '모델이 이 요청을 처리하지 않겠다고 했어요.'],
  [/^Cancelled before VM assignment/, '시작하기 전에 취소됐어요.'],
  [/^Local execution barrier completed/, '취소됐어요.'],
];

export function taskReason(reason: string | null | undefined): TaskReason | null {
  const raw = reason?.trim();
  if (!raw) return null;
  for (const [pattern, text] of known) if (pattern.test(raw)) return { text, detail: raw };
  if (/[가-힣]/.test(raw)) return { text: raw, detail: null };
  return { text: '작업 중 문제가 생겨 멈췄어요. 다시 요청해 주세요.', detail: raw };
}
