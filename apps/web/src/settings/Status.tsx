import { Check, Clock3, AlertCircle, MinusCircle } from 'lucide-react';
import type { Skill, Server } from './types';
import type { Vm } from '../types';
const failures: Readonly<Record<string, string>> = {
  connect_failed: '서버에 연결하지 못했어요.',
  disconnected: '연결이 끊겼어요.',
  tool_list_failed: '도구 목록을 불러오지 못했어요.',
  invalid_config: '연결 설정을 확인해 주세요.',
  authentication_failed: '서버가 인증을 거절했어요. URL의 토큰이나 인증 설정을 확인해 주세요.',
  access_denied: '서버가 접근을 거절했어요. 이 연결에 필요한 권한을 확인해 주세요.',
  endpoint_not_found: '이 주소에서 MCP 연결을 찾지 못했어요. 서버가 안내한 연결 주소를 확인해 주세요.',
  rate_limited: '서버의 요청 한도에 도달했어요. 잠시 후 자동으로 다시 시도해요.',
  server_unavailable: '서버가 오류를 반환했어요. 잠시 후 자동으로 다시 시도해요.',
  connection_timeout: '서버 응답을 기다리는 시간이 초과됐어요. 잠시 후 자동으로 다시 시도해요.',
  command_not_found: '컴퓨터에서 실행할 프로그램을 찾지 못했어요. 명령어와 설치 위치를 확인해 주세요.',
};
export function ExtensionStatus({
  item,
  vm,
  stale,
}: {
  item: Skill | Server;
  vm: Vm | undefined;
  stale: boolean;
}) {
  const pending = item.observed_revision !== item.revision || item.state === 'pending';
  const fresh = !stale && !!vm?.last_seen_at && Date.now() - Date.parse(vm.last_seen_at) < 60000;
  const failed = !pending && item.state === 'error';
  const label = pending
    ? item.enabled
      ? '적용 대기'
      : '사용 중지 반영 대기'
    : failed
      ? '확인 필요'
      : item.state === 'disabled'
        ? '사용 중지됨'
        : fresh
          ? item.state === 'connected'
            ? `연결됨 · 도구 ${item.tool_count}개`
            : '사용 준비됨'
          : '마지막 반영 확인됨';
  const Icon = pending ? Clock3 : failed ? AlertCircle : item.state === 'disabled' ? MinusCircle : Check;
  return (
    <div className="extension-status" role="status">
      <span className={failed ? 'is-error' : pending ? 'is-pending' : 'is-observed'}>
        <Icon size={13} />
        {label}
      </span>
      {failed && <small>{failures[item.error_code ?? ''] ?? '컴퓨터에서 설정을 적용하지 못했어요.'}</small>}
      {pending && (
        <small>
          {fresh
            ? '컴퓨터에서 반영을 기다리고 있어요. 작업 중이면 끝난 뒤 적용돼요.'
            : '컴퓨터가 다시 연결되면 반영돼요.'}
        </small>
      )}
      {item.observed_at && (
        <time dateTime={item.observed_at}>
          마지막 확인{' '}
          {new Date(item.observed_at).toLocaleString('ko-KR', {
            month: 'short',
            day: 'numeric',
            hour: '2-digit',
            minute: '2-digit',
          })}
        </time>
      )}
    </div>
  );
}
