import type { ResponseInputItem } from '../../packages/provider/index.ts';
import type { InfrastructureFailure } from './runtime-diagnostic.ts';

const accountTypes = new Set(['authentication_error', 'permission_error', 'insufficient_quota']);

export function rejectedRequest(failure: InfrastructureFailure | undefined): boolean {
  if (!failure || failure.code !== 'provider_http_error') return false;
  if (failure.http_status !== 400 && failure.http_status !== 413 && failure.http_status !== 422) return false;
  return !accountTypes.has(failure.api_type ?? '');
}

function hasImage(item: ResponseInputItem): boolean {
  return 'content' in item && Array.isArray(item.content) && item.content.some(part => part.type === 'input_image');
}

export function stripRecentImages(input: ResponseInputItem[], since: number): number {
  let removed = 0;
  for (let index = input.length - 1; index >= since; index--) {
    const item = input[index];
    if (item && hasImage(item)) { input.splice(index, 1); removed++; }
  }
  return removed;
}

export function rejectedRequestFeedback(failure: InfrastructureFailure, removedImages: number, attempt: number): ResponseInputItem {
  return { role: 'user', content: JSON.stringify({
    kind: 'provider_request_rejected', http_status: failure.http_status, api_type: failure.api_type ?? null, api_code: failure.api_code ?? null,
    removed_images: removedImages, attempt, executed_calls: 0,
    instruction: removedImages
      ? 'The model provider rejected the previous request before any response. Images added since your last turn were removed because they are the likely cause (for example an image whose dimensions exceed the provider limit). Tool actions that already ran completed; do not replay them. Continue with text-based observation instead, such as browser_snapshot or browser_find, or a viewport-sized screenshot.'
      : 'The model provider rejected the previous request before any response. No images were added since your last turn. Reduce what you send next, for example shorter tool output or fewer attachments, and continue. Tool actions that already ran completed; do not replay them.',
  }) };
}
