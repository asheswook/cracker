import { hybridEnabled } from './native-hybrid';
import { z } from 'zod';
import type { NativeComposerController } from './native-composer';
import type { NativeComposerMessage } from './native-bridge';
const Connected = z.object({ version: z.literal(1), platform: z.literal('ios'), document: z.uuid() });
export async function postComposer(message: NativeComposerMessage) {
  const bridge = window.webkit?.messageHandlers?.assistantNative;
  if (!bridge) throw new Error('Native composer unavailable');
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    const response = await Promise.race([bridge.postMessage(message), new Promise<never>((_, reject) => {
      timer = setTimeout(() => reject(new Error('Native composer timed out')), 3000);
    })]);
    if (message.method !== 'composerConnect' && response !== null) throw new Error('Native composer rejected state');
    return response;
  } finally { clearTimeout(timer); }
}
export async function connectComposer(controller: NativeComposerController, current: () => boolean = () => true): Promise<boolean> {
  if (!hybridEnabled()) return false;
  const reply = await postComposer({ method: 'composerConnect', version: 1, document: controller.document });
  const result = Connected.safeParse(reply);
  if (!current() || !result.success || result.data.document !== controller.document) return false;
  const state = controller.snapshot();
  if (!state) return false;
  await postComposer({ method: 'composerState', state });
  return current();
}
