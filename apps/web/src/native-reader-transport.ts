import { ReaderReply } from './native-reader-protocol';
import type { ReaderPacket, ReaderReplyValue } from './native-reader-protocol';
declare global {
  interface Window { __assistantReaderEvent?: (snapshot: unknown) => { ok: boolean } }
}
export async function postReader(packet: ReaderPacket): Promise<ReaderReplyValue> {
  const bridge = window.webkit?.messageHandlers?.assistantReader;
  if (!bridge) throw new Error('reader_unavailable');
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return ReaderReply.parse(await Promise.race([bridge.postMessage(packet), new Promise<never>((_, reject) => {
      timer = setTimeout(() => reject(new Error('reader_timeout')), 3000);
    })]));
  } finally { clearTimeout(timer); }
}
