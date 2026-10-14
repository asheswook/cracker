import { SubscriptionReply, type SubscriptionCommand, type SubscriptionResult } from '../../../packages/models/subscription-schema';
import { http } from './api';

export async function subscriptionRequest(vmId: string, command: SubscriptionCommand, signal: AbortSignal): Promise<SubscriptionResult> {
  const request_id = crypto.randomUUID();
  let reply = SubscriptionReply.parse(await http.post('/v1/subscription', { json: { vm_id: vmId, request_id, command }, signal }).json());
  const deadline = Date.now() + 55000;
  while (reply.status === 'pending' || reply.status === 'running') {
    if (Date.now() >= deadline) throw new Error('컴퓨터 응답이 없어요. 연결 상태를 확인해 주세요.');
    await subscriptionDelay(signal);
    reply = SubscriptionReply.parse(await http.get(`/v1/subscription/${request_id}`, { searchParams: { vm_id: vmId }, signal }).json());
  }
  if (!reply.result || reply.status !== 'completed' || reply.result.action !== command.action) throw new Error('구독 연결 요청을 완료하지 못했어요. 다시 시도해 주세요.');
  return reply.result;
}
export function subscriptionDelay(signal: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    signal.throwIfAborted();
    const abort = () => { clearTimeout(timer); reject(new DOMException('Aborted', 'AbortError')); };
    const timer = setTimeout(() => { signal.removeEventListener('abort', abort); resolve(); }, 1500);
    signal.addEventListener('abort', abort, { once: true });
  });
}
