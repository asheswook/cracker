import { hybridEnabled } from './native-hybrid';
import { z } from 'zod';
import { HeaderEvent } from './independent-header-protocol';
import type { HeaderReply } from './independent-header-protocol';
declare global {
  interface Window {
    __assistantHeaderEvent?: (packet: unknown) => HeaderReply;
    __assistantHeaderRender?: (packet: unknown) => HeaderReply;
  }
}
const Reply = z.object({ ok: z.boolean(), error: z.string().optional() });
export function independentHeaderEnabled() {
  return hybridEnabled() || window.__ASSISTANT_HYBRID_ROLE__ === 'header';
}
export async function postHeader(packet: object): Promise<HeaderReply> {
  const bridge = window.webkit?.messageHandlers?.assistantHeader;
  if (!bridge) throw new Error('header_bridge_missing');
  if (new TextEncoder().encode(JSON.stringify(packet)).length > 32768) throw new Error('header_packet_size');
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    const reply = Reply.parse(await Promise.race([bridge.postMessage(packet), new Promise<never>((_, reject) => {
      timer = setTimeout(() => reject(new Error('header_timeout')), 3000);
    })]));
    if (!reply.ok) throw new Error(reply.error ?? 'header_rejected');
    return { ok: true };
  } finally { clearTimeout(timer); }
}

export function listenHeaderFallback(receive: (packet: unknown) => HeaderReply): () => void {
  const listener = (event: Event) => {
    if (!(event instanceof CustomEvent)) return;
    const parsed = HeaderEvent.safeParse(event.detail);
    if (parsed.success && parsed.data.kind === 'fallback') receive(parsed.data);
  };
  window.addEventListener('assistant-header-fallback', listener);
  return () => window.removeEventListener('assistant-header-fallback', listener);
}
