import { HTTPError, TimeoutError } from 'ky';
import { http } from './api';

export type ViewingUpdate = {
  readonly installation_id: string;
  readonly page_id: string;
  readonly sequence: number;
  readonly active: boolean;
  readonly observed_at: number;
  readonly conversation_id?: string;
};

export async function sendViewing(update: ViewingUpdate): Promise<void> {
  try {
    await http.put('/v1/notifications/viewing', {
      json: update, timeout: 1200, retry: 0, keepalive: true,
    });
  } catch (error) {
    if (error instanceof HTTPError || error instanceof TimeoutError || error instanceof TypeError) return;
    throw error;
  }
}

export function observeNotificationAttention(
  installation: string,
  send: (update: ViewingUpdate) => Promise<void> = sendViewing,
  options?: { readonly conversation: string; readonly nativeAttention?: (conversation: string | null) => Promise<boolean> },
): () => void {
  const page = crypto.randomUUID();
  let sequence = 0;
  let active = false;
  let timer: ReturnType<typeof setTimeout> | undefined;
  let disposed = false;
  let checkRevision = 0;
  const publish = (viewing: boolean) => {
    active = viewing;
    void send({ installation_id: installation, page_id: page, sequence: ++sequence,
      active: viewing, observed_at: Date.now(), ...(options ? { conversation_id: options.conversation } : {}) });
  };
  const clear = () => {
    clearTimeout(timer);
    checkRevision++;
    if (options?.nativeAttention) void options.nativeAttention(null);
    if (active) publish(false);
  };
  const check = async () => {
    clearTimeout(timer);
    if (disposed) return;
    const revision = ++checkRevision;
    const visible = () => document.visibilityState === 'visible' && !document.querySelector('dialog:modal');
    if (!visible()) {
      clear();
      if (document.visibilityState === 'visible') timer = setTimeout(check, 1000);
      return;
    }
    const focused = options?.nativeAttention ? await options.nativeAttention(options.conversation) : document.hasFocus();
    if (disposed || revision !== checkRevision) return;
    if (focused && visible()) publish(true);
    else if (active) publish(false);
    timer = setTimeout(check, 1000);
  };
  window.addEventListener('focus', check);
  const blur = options?.nativeAttention ? check : clear;
  window.addEventListener('blur', blur);
  window.addEventListener('pagehide', clear);
  window.addEventListener('pageshow', check);
  document.addEventListener('visibilitychange', check);
  check();
  return () => {
    disposed = true;
    clear();
    window.removeEventListener('focus', check);
    window.removeEventListener('blur', blur);
    window.removeEventListener('pagehide', clear);
    window.removeEventListener('pageshow', check);
    document.removeEventListener('visibilitychange', check);
  };
}
