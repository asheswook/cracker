/** Typed HTTP client for the control service's knowledge tree routes (services/control/routes/knowledge-tree.ts). */
import type { KyInstance } from 'ky';
import { z } from 'zod';
import {
  ApplyResult, ClefRaw, EmbedResult, EmbedTextsResult, QueueItem, QueueStatus, SearchResult, Snapshot, SourcesResult, VectorsResult,
  type ClefRequest, type OpInput,
} from '../../packages/knowledge-tree/schema.ts';

const SnapshotResponse = z.object({ version: z.string(), unchanged: z.boolean(), snapshot: Snapshot.optional() });

export type TreeClient = ReturnType<typeof treeClient>;
/** `run` scopes question-time calls to an owned run; null uses the workspace-wide background routes. */
export function treeClient(http: KyInstance, run: string | null) {
  const path = run ? `v1/daemon/context/${run}/tree` : 'v1/daemon/knowledge-tree';
  const post = async <T>(route: string, schema: z.ZodType<T>, json: unknown, signal: AbortSignal, timeout = 30000) =>
    schema.parse(await http.post(`${path}/${route}`, { json, signal, timeout }).json());
  return {
    run,
    snapshot: async (signal: AbortSignal) => {
      const r = await post('snapshot', SnapshotResponse, {}, signal);
      if (!r.snapshot) throw new Error('snapshot_missing');
      return r.snapshot;
    },
    /** Returns the cached snapshot when the tree version did not move. */
    snapshotSince: (version: string | undefined, signal: AbortSignal) => post('snapshot', SnapshotResponse, version ? { version } : {}, signal),
    search: (text: string, signal: AbortSignal) => post('search', SearchResult, { text: text.slice(0, 12000) }, signal, 10000),
    vectors: (signal: AbortSignal, nodeIds?: readonly string[]) => post('vectors', VectorsResult, nodeIds ? { node_ids: nodeIds } : {}, signal),
    embedTexts: (texts: readonly string[], signal: AbortSignal) => post('embed-texts', EmbedTextsResult, { texts: texts.map(t => t.slice(0, 8000)) }, signal),
    embed: (items: readonly { node_id: string; text: string; sha256: string }[], signal: AbortSignal) => post('embed', EmbedResult, { items }, signal),
    clef: (request: ClefRequest, signal: AbortSignal) => post('clef', ClefRaw, request, signal, 10000),
    apply: (user_message_id: string, ops: readonly OpInput[], expected: Record<string, number>, signal: AbortSignal) => post('apply', ApplyResult, { user_message_id, ops, expected }, signal),
    sources: (ids: readonly string[], signal: AbortSignal) => post('sources', SourcesResult, { user_message_ids: ids }, signal),
    enqueue: (user_message_id: string, signal: AbortSignal) => post('queue/enqueue', z.object({ created: z.boolean(), state: z.string() }), { user_message_id }, signal),
    claim: (signal: AbortSignal) => post('queue/claim', z.object({ item: QueueItem.nullable() }), {}, signal),
    finish: (user_message_id: string, claim_id: string, signal: AbortSignal) => post('queue/finish', z.object({ ok: z.boolean() }), { user_message_id, claim_id }, signal),
    fail: (user_message_id: string, claim_id: string, error: string, signal: AbortSignal) => post('queue/fail', z.object({ state: z.string(), attempts: z.number(), retry_at: z.unknown() }), { user_message_id, claim_id, error: error.slice(0, 2000) }, signal),
    release: (user_message_id: string, claim_id: string, signal: AbortSignal) => post('queue/release', z.object({ ok: z.boolean() }), { user_message_id, claim_id }, signal),
    status: (signal: AbortSignal) => post('queue/status', QueueStatus, {}, signal),
  };
}
