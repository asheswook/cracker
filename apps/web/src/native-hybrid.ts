import { z } from 'zod';

const Capabilities = z.object({
  version: z.literal(1), platform: z.literal('ios'), document: z.uuid(),
  composer: z.literal(1), reader: z.literal(1), header: z.literal(1), footer: z.literal(1),
}).strict();
declare global {
  interface Window { readonly __ASSISTANT_HYBRID_ROLE__?: 'header' | 'footer' }
}
let negotiated = false;
export function hybridEnabled() { return negotiated; }
export async function negotiateHybrid(post?: (value: object) => Promise<unknown>): Promise<boolean> {
  negotiated = false;
  if (!post) return false;
  const document = crypto.randomUUID();
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    const result = Capabilities.safeParse(await Promise.race([
      post({ method: 'hybridConnect', version: 1, document }),
      new Promise<never>((_, reject) => { timer = setTimeout(() => reject(new Error('hybrid_timeout')), 3000); }),
    ]));
    negotiated = result.success && result.data.document === document;
    return negotiated;
  } catch { return false; }
  finally { clearTimeout(timer); }
}
