import { createHash } from 'node:crypto';
import { z } from 'zod';
import { DomainError } from '../protocol';
import { MAX_ARTIFACT_BYTES } from './limits';
import { artifactSearchText } from './search-text';

const Headers = z.object({ bytes: z.string().regex(/^\d+$/).transform(Number).pipe(z.number().int().nonnegative()),
  sha256: z.string().regex(/^[0-9a-f]{64}$/) });

export function streamingUpload(request: Request) {
  const bytes = request.headers.get('X-Artifact-Bytes');
  const sha256 = request.headers.get('X-Artifact-SHA256');
  if (bytes === null && sha256 === null) return null;
  const metadata = Headers.parse({ bytes, sha256 });
  if (metadata.bytes > MAX_ARTIFACT_BYTES)
    throw new DomainError('artifact_too_large', 'Maximum file size is 100 MB', 413);
  const reader = request.body?.getReader();
  const hash = createHash('sha256');
  const prefix = new Uint8Array(Math.min(metadata.bytes, 512 * 1024));
  let length = 0;
  let verified = false;
  const body = new ReadableStream<Uint8Array>({
    async pull(controller) {
      try {
        const part = reader ? await reader.read() : { done: true, value: undefined };
        if (part.done) {
          if (length !== metadata.bytes || hash.digest('hex') !== metadata.sha256)
            throw new DomainError('artifact_integrity_failed', 'File length or SHA-256 differs', 400);
          verified = true;
          reader?.releaseLock();
          controller.close();
          return;
        }
        const chunk = part.value;
        if (!chunk) throw new DomainError('artifact_integrity_failed', 'File chunk missing', 400);
        if (length + chunk.byteLength > metadata.bytes)
          throw new DomainError('artifact_integrity_failed', 'File exceeds declared length', 400);
        if (length < prefix.length) prefix.set(chunk.subarray(0, prefix.length - length), length);
        length += chunk.byteLength;
        hash.update(chunk);
        controller.enqueue(chunk);
      } catch (error) {
        await reader?.cancel(error);
        reader?.releaseLock();
        controller.error(error);
      }
    },
    async cancel(reason) { await reader?.cancel(reason); reader?.releaseLock(); },
  });
  return { ...metadata, body, finish(mediaType: string) {
    if (!verified) throw new DomainError('artifact_integrity_failed', 'File stream was not fully consumed', 400);
    const indexed = artifactSearchText(prefix, mediaType);
    return { text: indexed.text, truncated: indexed.truncated || (indexed.text !== null && length > prefix.length) };
  } };
}
