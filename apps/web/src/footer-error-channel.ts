import { z } from 'zod';
import { errorToasts } from './error-toasts';

const Notice = z.object({ id: z.string().max(16384), message: z.string().max(8192) }).strict();

export function receiveFooterErrors(document: string) {
  const channel = new BroadcastChannel(`assistant-footer-errors:${document}`);
  channel.onmessage = (event: MessageEvent<unknown>) => {
    const notice = Notice.safeParse(event.data);
    if (notice.success) errorToasts.show(notice.data.message, notice.data.id);
  };
  return () => channel.close();
}

export function forwardFooterErrors(document: string) {
  const channel = new BroadcastChannel(`assistant-footer-errors:${document}`);
  const publish = () => {
    for (const notice of errorToasts.snapshot()) channel.postMessage(notice);
  };
  const unsubscribe = errorToasts.subscribe(publish);
  publish();
  return () => { unsubscribe(); channel.close(); };
}
