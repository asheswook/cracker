import { Hono, type Context } from 'hono';
import { z } from 'zod';
import type { AppEnv } from '../auth';
import type { Database } from '../db';
import { embedTexts, rawClef, type KnowledgeTreeAi } from '../../../packages/knowledge-tree/ai';
import {
  ApplyRequest, ClefRequest, EmbedRequest, EmbedTextsRequest, EnqueueRequest, VectorsRequest, FailRequest, FinishRequest, SearchRequest, SEARCH_LIMIT, SourcesRequest,
} from '../../../packages/knowledge-tree/schema';
import * as store from '../../../packages/knowledge-tree/store';
import { ownedScope } from '../../../packages/context/store-read';
import { DomainError } from '../../../packages/protocol';

/**
 * Daemon routes for the workspace knowledge tree, mounted twice:
 * - `/context/:run/tree/*` (question time): the VM credential must own the run in the path.
 * - `/knowledge-tree/*` (background growth): workspace-wide, authorized by the VM credential (the daemon session is
 *   fenced by the control boundary), so growth never depends on a finished or pre-restart run.
 */
export function knowledgeTreeRoutes(sql: Database, ai?: KnowledgeTreeAi) {
  const app = new Hono<AppEnv>();
  const authorize = async (c: Context<AppEnv>) => {
    const principal = c.get('principal');
    if (principal.role !== 'vm' || !principal.vm_id) throw new DomainError('forbidden', 'VM credentials required', 403);
    const run = c.req.param('run');
    if (run !== undefined) await ownedScope(sql, principal, z.uuid().parse(run), false, 'backfill');
    return principal.workspace_id;
  };
  for (const base of ['/context/:run/tree', '/knowledge-tree']) {
    app.post(`${base}/snapshot`, async c => {
      const workspace = await authorize(c);
      const known = z.object({ version: z.string().max(80).optional() }).parse(await c.req.json().catch(() => ({}))).version;
      return c.json(await sql.begin('isolation level repeatable read read only', async tx => {
        const version = await store.treeVersion(tx, workspace);
        if (known && known === version) return { version, unchanged: true };
        return { version, unchanged: false, snapshot: await store.readSnapshot(tx, workspace) };
      }));
    });
    app.post(`${base}/search`, async c => {
      const workspace = await authorize(c), request = SearchRequest.parse(await c.req.json());
      const { vectors, ms } = await embedTexts(ai, [request.text]);
      const vector = vectors[0];
      if (!vector) return c.json({ error: { code: 'invalid_embeddings', message: 'Embedding failed' } }, 503);
      const start = performance.now(), ranking = await store.denseSearch(sql, workspace, vector, SEARCH_LIMIT);
      return c.json({ ranking, embed_ms: ms, search_ms: performance.now() - start });
    });
    app.post(`${base}/embed`, async c => {
      const workspace = await authorize(c), request = EmbedRequest.parse(await c.req.json());
      const { vectors, ms } = await embedTexts(ai, request.items.map(i => i.text));
      const result = await store.setEmbeddings(sql, workspace, request.items.map((item, i) => ({ node_id: item.node_id, sha256: item.sha256, vector: vectors[i] ?? [] })));
      return c.json({ ...result, embed_ms: ms });
    });
    app.post(`${base}/vectors`, async c => {
      const workspace = await authorize(c), request = VectorsRequest.parse(await c.req.json());
      return c.json({ vectors: await store.readVectors(sql, workspace, request.node_ids) });
    });
    app.post(`${base}/embed-texts`, async c => {
      await authorize(c);
      const request = EmbedTextsRequest.parse(await c.req.json()), { vectors, ms } = await embedTexts(ai, request.texts);
      return c.json({ vectors, embed_ms: ms });
    });
    app.post(`${base}/clef`, async c => {
      await authorize(c);
      return c.json(await rawClef(ai, ClefRequest.parse(await c.req.json())));
    });
    app.post(`${base}/apply`, async c => {
      const workspace = await authorize(c);
      return c.json(await store.applyOps(sql, workspace, ApplyRequest.parse(await c.req.json())));
    });
    app.post(`${base}/sources`, async c => {
      const workspace = await authorize(c), request = SourcesRequest.parse(await c.req.json());
      return c.json({ exchanges: await store.readSources(sql, workspace, request.user_message_ids) });
    });
    app.post(`${base}/queue/enqueue`, async c => {
      const workspace = await authorize(c);
      return c.json(await store.enqueue(sql, workspace, EnqueueRequest.parse(await c.req.json()).user_message_id));
    });
    app.post(`${base}/queue/claim`, async c => {
      const workspace = await authorize(c);
      return c.json({ item: await store.claimNext(sql, workspace) });
    });
    app.post(`${base}/queue/finish`, async c => {
      const workspace = await authorize(c), request = FinishRequest.parse(await c.req.json());
      await store.finish(sql, workspace, request.user_message_id, request.claim_id);
      return c.json({ ok: true });
    });
    app.post(`${base}/queue/fail`, async c => {
      const workspace = await authorize(c), request = FailRequest.parse(await c.req.json());
      return c.json(await store.fail(sql, workspace, request.user_message_id, request.claim_id, request.error));
    });
    app.post(`${base}/queue/release`, async c => {
      const workspace = await authorize(c), request = FinishRequest.parse(await c.req.json());
      await store.release(sql, workspace, request.user_message_id, request.claim_id);
      return c.json({ ok: true });
    });
    app.post(`${base}/queue/status`, async c => {
      const workspace = await authorize(c);
      return c.json(await store.queueStatus(sql, workspace));
    });
  }
  return app;
}
