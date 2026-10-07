import { hybridEnabled } from './native-hybrid';
import { z } from 'zod';
import { footerPacketFits } from './independent-footer-protocol';
import type { FooterReply } from './independent-footer-protocol';
declare global {
  interface Window {
    __assistantFooterRender?: (input: unknown) => FooterReply;
    __assistantFooterEvent?: (input: unknown) => Promise<FooterReply>;
  }
}
const Reply = z.object({ ok: z.boolean(), error: z.string().optional() });
export function independentFooterEnabled() {
  return hybridEnabled() || window.__ASSISTANT_HYBRID_ROLE__ === 'footer';
}
export async function postFooter(packet: object, action = false): Promise<FooterReply> {
  const bridge = window.webkit?.messageHandlers?.assistantFooter;
  if (!bridge || !footerPacketFits(packet)) return { ok: false, error: bridge ? 'footer_packet_size' : 'footer_bridge_missing' };
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    const reply = await Promise.race([bridge.postMessage(packet), new Promise<FooterReply>(resolve => {
      timer = setTimeout(() => resolve({ ok: false, error: 'footer_timeout' }), action ? 150000 : 3000);
    })]);
    const parsed = Reply.safeParse(reply);
    return parsed.success ? { ok: parsed.data.ok, ...(parsed.data.error ? { error: parsed.data.error } : {}) } : { ok: false, error: 'footer_reply_invalid' };
  } catch { return { ok: false, error: 'footer_transport_failed' }; }
  finally { clearTimeout(timer); }
}
