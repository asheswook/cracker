import { useEffect, useState } from 'react';
import { z } from 'zod';
import { Artifact, Id } from './types';
import { client } from './store';
import { MAX_ARTIFACT_BYTES } from '../../../packages/artifacts/limits';
import { errorToasts } from './error-toasts';
export type UploadDraft = {
  id: Id;
  workspace: Id;
  conversation: Id;
  file: File;
  artifact?: Artifact;
  error?: string;
};
const changed = new EventTarget();
const transfers = new Map<Id, number>();
const cancellations = new Map<Id, AbortController>();
let hashing: Promise<unknown> = Promise.resolve();
const failures = new Map<Id, string>();
function reportFailure(id: Id) {
  failures.set(id, '파일 상태를 기기에 저장하지 못했어요. 저장 공간을 확인해 주세요.');
  changed.dispatchEvent(new Event('change'));
}
let opened: Promise<IDBDatabase> | undefined;
const database = () =>
  (opened ??= new Promise<IDBDatabase>((resolve, reject) => {
    const request = indexedDB.open('assistant-attachment-drafts', 1);
    request.onupgradeneeded = () => request.result.createObjectStore('files', { keyPath: 'id' });
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error);
  }).catch((error: unknown) => {
    opened = undefined;
    throw error;
  }));
async function records(): Promise<UploadDraft[]> {
  const db = await database();
  return new Promise((resolve, reject) => {
    const request = db.transaction('files').objectStore('files').getAll();
    request.onsuccess = () => resolve(request.result as UploadDraft[]);
    request.onerror = () => reject(request.error);
  });
}
async function write(record: UploadDraft | Id) {
  const db = await database();
  await new Promise<void>((resolve, reject) => {
    const tx = db.transaction('files', 'readwrite');
    const store = tx.objectStore('files');
    if (typeof record === 'string') store.delete(record);
    else store.put(record);
    tx.oncomplete = () => resolve();
    tx.onerror = () => reject(tx.error);
    tx.onabort = () => reject(tx.error);
  });
  failures.delete(typeof record === 'string' ? record : record.id);
  changed.dispatchEvent(new Event('change'));
}
export async function uploadDraft(draft: UploadDraft) {
  if (transfers.has(draft.id) || draft.artifact) return;
  if (client.snapshot().workspace !== draft.workspace) return;
  transfers.set(draft.id, 0);
  const abort = new AbortController();
  cancellations.set(draft.id, abort);
  changed.dispatchEvent(new Event('change'));
  try {
    const pendingHash = hashing.then(async () => {
      abort.signal.throwIfAborted();
      return crypto.subtle.digest('SHA-256', await draft.file.arrayBuffer());
    });
    hashing = pendingHash.catch((error: unknown) => {
      if (!(error instanceof Error)) throw error;
    });
    const digest = new Uint8Array(await pendingHash);
    abort.signal.throwIfAborted();
    const sha256 = Array.from(digest, byte => byte.toString(16).padStart(2, '0')).join('');
    const artifact = await new Promise<Artifact>((resolve, reject) => {
      const request = new XMLHttpRequest();
      request.open('POST', `/v1/conversations/${draft.conversation}/artifacts`);
      request.withCredentials = true;
      request.timeout = 600000;
      request.setRequestHeader('X-Artifact-Id', draft.id);
      request.setRequestHeader('X-Artifact-Name', encodeURIComponent(draft.file.name));
      request.setRequestHeader('X-Artifact-Bytes', String(draft.file.size));
      request.setRequestHeader('X-Artifact-SHA256', sha256);
      request.setRequestHeader('Content-Type', draft.file.type || 'application/octet-stream');
      request.upload.onprogress = (event) => {
        if (event.lengthComputable) transfers.set(draft.id, Math.round((event.loaded / event.total) * 100));
        changed.dispatchEvent(new Event('change'));
      };
      request.onload = () => {
        if (request.status < 200 || request.status >= 300) {
          reject(new Error(`업로드 실패 (${request.status})`));
          return;
        }
        try {
          resolve(z.object({ artifact: Artifact }).parse(JSON.parse(request.responseText)).artifact);
        } catch {
          reject(new Error('업로드 응답을 확인하지 못했어요.'));
        }
      };
      request.onerror = () => reject(new Error('연결이 끊겼어요. 파일을 보관했으니 다시 시도해 주세요.'));
      request.ontimeout = () => reject(new Error('업로드 시간이 초과됐어요. 다시 시도해 주세요.'));
      request.onabort = () => reject(new Error('첨부 업로드를 취소했어요.'));
      abort.signal.addEventListener('abort', () => request.abort(), { once: true });
      request.send(draft.file);
    });
    if (!abort.signal.aborted) await write({ ...draft, artifact, error: '' });
  } catch (error) {
    if (!abort.signal.aborted) {
      const message = error instanceof Error ? error.message : '업로드 실패';
      await write({ ...draft, error: message });
      const current = client.snapshot();
      if (current.workspace === draft.workspace && current.selected === draft.conversation)
        errorToasts.show(`${draft.file.name}: ${message}`);
    }
  } finally {
    cancellations.delete(draft.id);
    transfers.delete(draft.id);
    changed.dispatchEvent(new Event('change'));
  }
}
export async function addFiles(files: File[]) {
  if (!files.length) return;
  const { workspace, selected } = client.snapshot();
  if (!workspace) throw new Error('먼저 연결해 주세요.');
  if (files.some((file) => file.size > MAX_ARTIFACT_BYTES))
    throw new Error('파일은 각각 100MB까지 첨부할 수 있어요.');
  const conversation = selected ?? (await client.create());
  const existing = (await records()).filter(
    (d) => d.workspace === workspace && d.conversation === conversation,
  );
  if (existing.length + files.length > 8) throw new Error('한 번에 파일 8개까지 첨부할 수 있어요.');
  for (const file of files) {
    const draft: UploadDraft = { id: Id.parse(crypto.randomUUID()), workspace, conversation, file };
    await write(draft);
    void uploadDraft(draft).catch(() => reportFailure(draft.id));
  }
}
export async function removeDrafts(ids: Id[]) {
  for (const id of ids) { cancellations.get(id)?.abort(); await write(id); }
}
export function useAttachmentDrafts(workspace: Id | null, conversation: Id | null) {
  const [drafts, setDrafts] = useState<UploadDraft[]>([]);
  const scope = `${workspace}:${conversation}`;
  const [load, setLoad] = useState<{
    readonly scope: string;
    readonly status: 'loading' | 'ready' | 'failed' | 'retrying';
  }>({ scope: '', status: 'loading' });
  const [retryRevision, setRetryRevision] = useState(0);
  const [, render] = useState(0);
  useEffect(() => {
    let active = true;
    let revision = 0;
    const refresh = () => {
      const current = ++revision;
      render((n) => n + 1);
      setLoad((previous) => ({
        scope,
        status: previous.scope === scope &&
          (previous.status === 'failed' || previous.status === 'retrying') ? 'retrying' : 'loading',
      }));
      void records()
        .then((all) => {
          if (active && current === revision) {
            setDrafts(all.filter((d) => d.workspace === workspace && d.conversation === conversation));
            setLoad({ scope, status: 'ready' });
          }
        })
        .catch(() => {
          if (active && current === revision) setLoad({ scope, status: 'failed' });
        });
    };
    refresh();
    changed.addEventListener('change', refresh);
    return () => {
      active = false;
      changed.removeEventListener('change', refresh);
    };
  }, [workspace, conversation, scope, retryRevision]);
  const status = load.scope === scope ? load.status : 'loading';
  const state = client.snapshot();
  const used = new Set(
    [...state.messages, ...state.outbox].flatMap((message) => message.attachments?.map((a) => a.id) ?? []),
  );
  const visible = drafts.filter(
    (d) => d.workspace === workspace && d.conversation === conversation && !used.has(d.id),
  );
  return {
    drafts: visible,
    error: visible.map((d) => failures.get(d.id)).find(Boolean) || '',
    storageFailed: status === 'failed' || status === 'retrying',
    retrying: status === 'retrying',
    retry: () => setRetryRevision((revision) => revision + 1),
    loading: status !== 'ready',
    progress: (id: Id) => transfers.get(id),
  };
}
