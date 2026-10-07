import { expect, test } from 'bun:test';
import { Artifact } from '../packages/protocol';
import { MAX_ARTIFACT_BYTES } from '../packages/artifacts/limits';
import { artifactFixture, send } from './artifacts-fixture';

const { fixture, sql, storage } = artifactFixture();
const chunk = new Uint8Array(64 * 1024).fill(42);
function digest(length: number) {
  const hash = new Bun.CryptoHasher('sha256');
  for (let offset = 0; offset < length; offset += chunk.length) hash.update(chunk.subarray(0, Math.min(chunk.length, length - offset)));
  return hash.digest('hex');
}
function body(length: number, fail = false) {
  let offset = 0;
  return new ReadableStream<Uint8Array>({ pull(controller) {
    if (offset >= length) {
      if (fail) controller.error(new Error('fixture connection lost'));
      else controller.close();
      return;
    }
    const part = chunk.slice(0, Math.min(chunk.length, length - offset));
    offset += part.length; controller.enqueue(part);
  } });
}
function request(input: { readonly id: string; readonly actual: number; readonly declared?: number; readonly hash?: string; readonly fail?: boolean }) {
  const size = input.declared ?? input.actual;
  return { method: 'POST', headers: { 'X-Artifact-Id': input.id, 'X-Artifact-Name': 'stream.bin',
    'Content-Type': 'application/octet-stream', 'X-Artifact-Bytes': String(size),
    'X-Artifact-SHA256': input.hash ?? digest(size) }, body: body(input.actual, input.fail) };
}

test('100 MB upload streams through actual API and downloads with exact length and hash', async () => {
  const context = await fixture(), id = crypto.randomUUID();
  const response = await send(context, `/v1/conversations/${context.conversation}/artifacts`, request({ id, actual: MAX_ARTIFACT_BYTES }));
  expect(response.status).toBe(201);
  const result = await response.json();
  const artifact = Artifact.parse(Reflect.get(result, 'artifact'));
  expect(artifact.bytes).toBe(MAX_ARTIFACT_BYTES);
  const download = await send(context, `/v1/artifacts/${id}/content`);
  if (!download.body) throw new Error('Missing downloaded stream');
  const hash = new Bun.CryptoHasher('sha256');
  const reader = download.body.getReader();
  let length = 0;
  while (true) {
    const part = await reader.read();
    if (part.done) break;
    length += part.value.byteLength; hash.update(part.value);
  }
  reader.releaseLock();
  expect(length).toBe(MAX_ARTIFACT_BYTES);
  expect(hash.digest('hex')).toBe(digest(MAX_ARTIFACT_BYTES));
}, 30000);

for (const input of [
  { name: 'forged digest', actual: 1024, hash: '0'.repeat(64) },
  { name: 'short EOF', actual: 1023, declared: 1024 },
  { name: 'long body', actual: 1025, declared: 1024 },
  { name: 'interrupted body', actual: 1024, fail: true },
]) test(`${input.name} cannot publish an object and releases its reservation`, async () => {
  const context = await fixture(), id = crypto.randomUUID();
  const response = await send(context, `/v1/conversations/${context.conversation}/artifacts`, request({ ...input, id }));
  expect(response.status).toBeGreaterThanOrEqual(400);
  const rows = await sql`SELECT state,purged_at FROM assistant.artifacts WHERE id=${id}`;
  expect(rows[0]?.['state']).toBe('failed');
  expect(rows[0]?.['purged_at']).not.toBeNull();
  expect(await storage.get(`${context.workspace}/${id}`)).toBeNull();
  const retry = await send(context, `/v1/conversations/${context.conversation}/artifacts`, request({ id: crypto.randomUUID(), actual: 1024 }));
  expect(retry.status).toBe(201);
});

test('declared 100 MB plus one byte is rejected before any reservation or object', async () => {
  const context = await fixture(), id = crypto.randomUUID();
  const response = await send(context, `/v1/conversations/${context.conversation}/artifacts`, request({ id, actual: 0, declared: MAX_ARTIFACT_BYTES + 1, hash: '0'.repeat(64) }));
  expect(response.status).toBe(413);
  expect(await sql`SELECT id FROM assistant.artifacts WHERE id=${id}`).toHaveLength(0);
  expect(await storage.get(`${context.workspace}/${id}`)).toBeNull();
});

test('both streaming metadata headers are required together', async () => {
  const context = await fixture();
  const response = await send(context, `/v1/conversations/${context.conversation}/artifacts`, {
    method: 'POST', headers: { 'X-Artifact-Id': crypto.randomUUID(), 'X-Artifact-Name': 'empty', 'X-Artifact-Bytes': '0' }, body: '',
  });
  expect(response.status).toBe(400);
});
