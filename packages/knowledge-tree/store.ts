/**
 * Postgres access for the workspace knowledge tree. Every function takes an explicit workspace id; route handlers
 * authorize the caller (daemon credential + owned run) before calling in.
 */
import { z } from 'zod';
import type { Database, Query, Transaction } from '../../services/control/db';
import { sourceBatch } from '../context/source-batch';
import { DomainError } from '../protocol';
import { forgetExchanges } from './forget.ts';
import {
  applyOps as applyTreeOps, embedText, linkKeyOf, opEvidence, sha256Hex, TreeError, type LogEntry, type TreeState,
} from './core.ts';
import {
  ApplyRequest, Evidence, Fact, Link, Node, QUEUE_LEASE_MS, QUEUE_MAX_ATTEMPTS, queueBackoffMs, SEARCH_LIMIT,
  type ApplyResult, type EmbedResult, type ExchangeSource, type QueueItem, type QueueStatus, type Snapshot,
} from './schema.ts';

const lockKey = (workspace: string, name: string) => `${workspace}:${name}`;
const num = z.coerce.number().int();
const iso = (v: unknown) => v instanceof Date ? v.toISOString() : String(v);

// ---------- snapshot ----------
const NodeRow = z.object({
  id: z.uuid(), parent_id: z.uuid().nullable(), kind: Node.shape.kind, title: z.string(), aliases: z.array(z.string()), summary: z.array(Fact), entities: z.array(z.string()),
  status: Node.shape.status, merged_into: z.uuid().nullable(), depth: num, revision: num, embedded_sha256: z.string().nullable(), created_sequence: num, updated_sequence: num,
});
const MemberRow = z.object({ node_id: z.uuid(), user_message_id: z.uuid(), role: z.enum(['owner', 'mention']), sequence: num });
const LinkRow = z.object({ from_node: z.uuid(), to_node: z.uuid(), kind: Link.shape.kind, evidence: z.array(Evidence), confidence: z.coerce.number(), revision: num });

export async function readSnapshot(sql: Query, workspace: string): Promise<Snapshot> {
  const [nodeRows, memberRows, linkRows, noiseRows, entityRows] = await Promise.all([
    sql`SELECT id,parent_id,kind,title,aliases,summary,entities,status,merged_into,depth,revision,embedded_sha256,created_sequence,updated_sequence FROM assistant.knowledge_nodes WHERE workspace_id=${workspace} ORDER BY created_sequence,id`,
    sql`SELECT k.node_id,k.user_message_id,k.role,m.sequence FROM assistant.knowledge_node_members k JOIN assistant.messages m ON m.workspace_id=k.workspace_id AND m.id=k.user_message_id WHERE k.workspace_id=${workspace} ORDER BY m.sequence,k.user_message_id`,
    sql`SELECT from_node,to_node,kind,evidence,confidence,revision FROM assistant.knowledge_links WHERE workspace_id=${workspace} ORDER BY created_at,from_node,to_node,kind`,
    sql`SELECT user_message_id FROM assistant.knowledge_noise n JOIN assistant.messages m ON m.workspace_id=n.workspace_id AND m.id=n.user_message_id WHERE n.workspace_id=${workspace} ORDER BY m.sequence`,
    sql`SELECT user_message_id,entities FROM assistant.knowledge_entities WHERE workspace_id=${workspace}`,
  ]);
  const members = z.array(MemberRow).parse(memberRows);
  const owners = new Map<string, string[]>(), mentions = new Map<string, string[]>(), sequence: Record<string, number> = {}, processed: string[] = [];
  for (const m of members) {
    const bucket = m.role === 'owner' ? owners : mentions;
    bucket.set(m.node_id, [...(bucket.get(m.node_id) ?? []), m.user_message_id]);
    if (m.role === 'owner') { processed.push(m.user_message_id); sequence[m.user_message_id] = m.sequence; }
  }
  const nodes = z.array(NodeRow).parse(nodeRows).map(n => Node.parse({ ...n, owners: owners.get(n.id) ?? [], mentions: mentions.get(n.id) ?? [] }));
  const links = z.array(LinkRow).parse(linkRows).map(l => ({ from: l.from_node, to: l.to_node, kind: l.kind, evidence: l.evidence, confidence: l.confidence, revision: l.revision }));
  const entities: Record<string, string[]> = {};
  for (const e of z.array(z.object({ user_message_id: z.uuid(), entities: z.array(z.string()) })).parse(entityRows)) entities[e.user_message_id] = e.entities;
  return { nodes, links, processed, sequence, noise: z.array(z.object({ user_message_id: z.uuid() })).parse(noiseRows).map(r => r.user_message_id), entities };
}

/** Cheap change marker: moves whenever nodes, memberships or links change (used to cache snapshots on the daemon). */
export async function treeVersion(sql: Query, workspace: string): Promise<string> {
  const row = (await sql`SELECT
      (SELECT coalesce(max(id),0) FROM assistant.knowledge_ops WHERE workspace_id=${workspace}) AS ops,
      (SELECT count(*) FROM assistant.knowledge_nodes WHERE workspace_id=${workspace}) AS nodes`)[0];
  const v = z.object({ ops: z.coerce.string(), nodes: z.coerce.string() }).parse(row);
  return `${v.ops}:${v.nodes}`;
}

// ---------- exchange sources ----------
const MESSAGE_CHARS = 60_000;
const ExchangeHead = z.object({ id: z.uuid(), conversation_id: z.uuid(), task_id: z.uuid().nullable(), sequence: num, content: z.string(), synthetic: z.boolean() });
const AssistantRow = z.object({ user_id: z.uuid(), id: z.uuid(), sequence: num, content: z.string() });

type LoadedExchange = ExchangeSource & { full: Map<string, string> };
/** User message plus the assistant messages answering it (response_to / applied_user_ids / same task before the next user turn). */
async function loadExchanges(sql: Query, workspace: string, ids: readonly string[]): Promise<Map<string, LoadedExchange>> {
  const unique = [...new Set(ids)], out = new Map<string, LoadedExchange>();
  if (!unique.length) return out;
  const heads = new Map(z.array(ExchangeHead).parse(await sql`SELECT id,conversation_id,task_id,sequence,content,synthetic FROM assistant.messages WHERE workspace_id=${workspace} AND role='user' AND id=ANY(${sql.array(unique)}::uuid[])`).map(h => [h.id, h]));
  const assistants = heads.size ? z.array(AssistantRow).parse(await sql`
    SELECT u.id AS user_id,a.id,a.sequence,a.content
    FROM assistant.messages u JOIN assistant.messages a ON a.workspace_id=u.workspace_id AND a.conversation_id=u.conversation_id AND a.role='assistant' AND a.sequence>u.sequence
    WHERE u.workspace_id=${workspace} AND u.role='user' AND u.id=ANY(${sql.array([...heads.keys()])}::uuid[])
      AND (a.response_to_message_id=u.id OR u.id=ANY(a.applied_user_ids)
        OR (a.response_to_message_id IS NULL AND cardinality(a.applied_user_ids)=0 AND a.task_id IS NOT DISTINCT FROM u.task_id
            AND a.sequence<COALESCE((SELECT min(n.sequence) FROM assistant.messages n WHERE n.workspace_id=u.workspace_id AND n.conversation_id=u.conversation_id AND n.role='user' AND NOT n.synthetic AND n.task_id IS NOT DISTINCT FROM u.task_id AND n.sequence>u.sequence),9223372036854775807)))
    ORDER BY u.id,a.sequence`) : [];
  const records = heads.size ? await sourceBatch(sql, { workspace, conversation: [...heads.values()][0]?.conversation_id ?? '' }, [...heads.keys(), ...assistants.map(a => a.id)]) : new Map();
  for (const id of unique) {
    const head = heads.get(id);
    if (!head) { out.set(id, { user_message_id: id, conversation_id: null, sequence: null, allowed: false, messages: [], full: new Map() }); continue; }
    const userOk = !head.synthetic && records.get(id)?.retentionAllowed === true;
    const full = new Map<string, string>(), messages: ExchangeSource['messages'] = [];
    if (userOk) {
      full.set(id, head.content); messages.push({ message_id: id, role: 'user', sequence: head.sequence, text: head.content.slice(0, MESSAGE_CHARS) });
      for (const a of assistants.filter(x => x.user_id === id).slice(0, 16)) {
        if (records.get(a.id)?.retentionAllowed !== true) continue;
        full.set(a.id, a.content); messages.push({ message_id: a.id, role: 'assistant', sequence: a.sequence, text: a.content.slice(0, MESSAGE_CHARS) });
      }
    }
    out.set(id, { user_message_id: id, conversation_id: head.conversation_id, sequence: head.sequence, allowed: userOk, messages, full });
  }
  return out;
}
export async function readSources(sql: Query, workspace: string, ids: readonly string[]): Promise<ExchangeSource[]> {
  const loaded = await loadExchanges(sql, workspace, ids);
  return ids.map(id => { const { full: _full, ...rest } = loaded.get(id) ?? { user_message_id: id, conversation_id: null, sequence: null, allowed: false, messages: [], full: new Map() }; return rest; });
}

// ---------- apply ----------
const nodeJson = (n: Node) => ({ title: n.title, aliases: JSON.stringify(n.aliases), summary: JSON.stringify(n.summary), entities: JSON.stringify(n.entities) });

/**
 * One transaction per batch, serialized per workspace. Steps: read snapshot → verify expected revisions → run the pure
 * ops (invariants + exact quotes against retention-allowed exchange text) → write nodes/members/links/noise/entities
 * → append knowledge_ops. Any failure rolls everything back.
 */
export async function applyOps(sql: Database, workspace: string, request: z.infer<typeof ApplyRequest>): Promise<ApplyResult> {
  return sql.begin(async tx => {
    await tx`SELECT pg_advisory_xact_lock(hashtextextended(${lockKey(workspace, 'knowledge-tree')},0))`;
    const current = await readSnapshot(tx, workspace);
    for (const [id, revision] of Object.entries(request.expected)) {
      const n = current.nodes.find(x => x.id === id);
      if (!n || n.revision !== revision) throw new DomainError('stale_revision', 'Node changed since it was read', 409);
    }
    const head = z.array(z.object({ sequence: num })).parse(await tx`SELECT sequence FROM assistant.messages WHERE workspace_id=${workspace} AND id=${request.user_message_id} AND role='user' AND NOT synthetic`)[0];
    if (!head) throw new DomainError('invalid_source', 'Exchange source is not a real user message of this workspace', 409);
    const evidence = opEvidence(request.ops);
    const exchanges = await loadExchanges(tx, workspace, [request.user_message_id, ...evidence.map(e => e.user_message_id)]);
    const texts = new Map<string, string>();
    for (const e of evidence) {
      const ex = exchanges.get(e.user_message_id);
      const text = ex?.full.get(e.message_id);
      if (!ex?.allowed || text === undefined) throw new DomainError('invalid_evidence', 'Evidence must quote a retained message of its exchange', 409);
      texts.set(e.message_id, text);
    }
    let applied;
    try { applied = applyTreeOps(current, request.ops, { user_message_id: request.user_message_id, sequence: head.sequence, texts }); }
    catch (error) { if (error instanceof TreeError) throw new DomainError('invalid_operation', error.message.slice(0, 200), 409); throw error; }
    // Nodes dropped by the batch (drop_node) are deleted with their memberships and links.
    const dropped = current.nodes.filter(n => !applied.state.nodes.some(x => x.id === n.id)).map(n => n.id);
    if (dropped.length) {
      await tx`DELETE FROM assistant.knowledge_links WHERE workspace_id=${workspace} AND (from_node=ANY(${tx.array(dropped)}::uuid[]) OR to_node=ANY(${tx.array(dropped)}::uuid[]))`;
      await tx`DELETE FROM assistant.knowledge_node_members WHERE workspace_id=${workspace} AND node_id=ANY(${tx.array(dropped)}::uuid[])`;
      await tx`SET CONSTRAINTS ALL DEFERRED`;
      await tx`DELETE FROM assistant.knowledge_nodes WHERE workspace_id=${workspace} AND id=ANY(${tx.array(dropped)}::uuid[])`;
    }
    await persist(tx, workspace, { ...current, nodes: current.nodes.filter(n => !dropped.includes(n.id)), links: current.links.filter(l => !dropped.includes(l.from) && !dropped.includes(l.to)) }, applied.state, applied.touched);
    for (const entry of applied.log) await logOp(tx, workspace, entry);
    return { revisions: Object.fromEntries(applied.state.nodes.filter(n => applied.touched.includes(n.id)).map(n => [n.id, n.revision])), touched: applied.touched, logged: applied.log.length };
  });
}
async function logOp(tx: Transaction, workspace: string, entry: LogEntry) {
  await tx`INSERT INTO assistant.knowledge_ops(workspace_id,user_message_id,op,before,after) VALUES(${workspace},${entry.user_message_id},${entry.op},${JSON.stringify(entry.before)}::text::jsonb,${JSON.stringify(entry.after)}::text::jsonb)`;
}
async function persist(tx: Transaction, workspace: string, before: TreeState, after: TreeState, touched: readonly string[]) {
  const touchedNodes = after.nodes.filter(n => touched.includes(n.id));
  for (const n of touchedNodes) {
    const j = nodeJson(n);
    await tx`INSERT INTO assistant.knowledge_nodes(workspace_id,id,parent_id,kind,title,aliases,summary,entities,status,merged_into,depth,revision,created_sequence,updated_sequence)
      VALUES(${workspace},${n.id},${n.parent_id},${n.kind},${j.title},${j.aliases}::text::jsonb,${j.summary}::text::jsonb,${j.entities}::text::jsonb,${n.status},${n.merged_into},${n.depth},${n.revision},${n.created_sequence},${n.updated_sequence})
      ON CONFLICT(workspace_id,id) DO UPDATE SET parent_id=EXCLUDED.parent_id,kind=EXCLUDED.kind,title=EXCLUDED.title,aliases=EXCLUDED.aliases,summary=EXCLUDED.summary,entities=EXCLUDED.entities,
        status=EXCLUDED.status,merged_into=EXCLUDED.merged_into,depth=EXCLUDED.depth,revision=EXCLUDED.revision,updated_sequence=EXCLUDED.updated_sequence,updated_at=now()`;
  }
  // Depth of untouched descendants is recomputed by the pure ops; persist any node whose depth/parent changed too.
  const beforeById = new Map(before.nodes.map(n => [n.id, n]));
  for (const n of after.nodes) {
    const b = beforeById.get(n.id);
    if (b && !touched.includes(n.id) && (b.depth !== n.depth || b.parent_id !== n.parent_id)) await tx`UPDATE assistant.knowledge_nodes SET depth=${n.depth},parent_id=${n.parent_id},updated_at=now() WHERE workspace_id=${workspace} AND id=${n.id}`;
  }
  if (touchedNodes.length) {
    await tx`DELETE FROM assistant.knowledge_node_members WHERE workspace_id=${workspace} AND node_id=ANY(${tx.array(touchedNodes.map(n => n.id))}::uuid[])`;
    for (const n of touchedNodes) {
      for (const id of n.owners) await tx`INSERT INTO assistant.knowledge_node_members(workspace_id,node_id,user_message_id,role) VALUES(${workspace},${n.id},${id},'owner')`;
      for (const id of n.mentions) await tx`INSERT INTO assistant.knowledge_node_members(workspace_id,node_id,user_message_id,role) VALUES(${workspace},${n.id},${id},'mention')`;
    }
  }
  const prior = new Map(before.links.map(l => [linkKeyOf(l), JSON.stringify(l)])), next = new Map(after.links.map(l => [linkKeyOf(l), l]));
  for (const l of before.links) if (!next.has(linkKeyOf(l))) await tx`DELETE FROM assistant.knowledge_links WHERE workspace_id=${workspace} AND from_node=${l.from} AND to_node=${l.to} AND kind=${l.kind}`;
  for (const [k, l] of next) {
    if (prior.get(k) === JSON.stringify(l)) continue;
    await tx`DELETE FROM assistant.knowledge_links WHERE workspace_id=${workspace} AND ((from_node=${l.from} AND to_node=${l.to} AND kind=${l.kind}) OR (${l.kind}::text='reference' AND from_node=${l.to} AND to_node=${l.from} AND kind='reference'))`;
    await tx`INSERT INTO assistant.knowledge_links(workspace_id,from_node,to_node,kind,evidence,confidence,revision) VALUES(${workspace},${l.from},${l.to},${l.kind},${JSON.stringify(l.evidence)}::text::jsonb,${l.confidence},${l.revision})`;
  }
  // Links rewritten by merge keep the same key set elsewhere; remove rows whose key vanished but were re-pointed.
  if (after.processed.length > before.processed.length) {
    for (const id of after.processed.filter(x => !before.processed.includes(x))) {
      if (after.noise.includes(id)) await tx`INSERT INTO assistant.knowledge_noise(workspace_id,user_message_id) VALUES(${workspace},${id}) ON CONFLICT DO NOTHING`;
      const ents = after.entities[id];
      if (ents) await tx`INSERT INTO assistant.knowledge_entities(workspace_id,user_message_id,entities) VALUES(${workspace},${id},${JSON.stringify(ents)}::text::jsonb) ON CONFLICT(workspace_id,user_message_id) DO UPDATE SET entities=EXCLUDED.entities`;
    }
  }
}

// ---------- embeddings & dense search ----------
const Vector = z.array(z.number().finite()).length(1024);
/** Stores vectors only for nodes whose current embed text still hashes to the supplied sha256 (otherwise reported stale). */
export async function setEmbeddings(sql: Database, workspace: string, items: readonly { node_id: string; sha256: string; vector: readonly number[] }[]): Promise<Pick<EmbedResult, 'stored' | 'stale'>> {
  return sql.begin(async tx => {
    const stored: string[] = [], stale: string[] = [];
    const rows = z.array(z.object({ id: z.uuid(), title: z.string(), aliases: z.array(z.string()), summary: z.array(Fact), status: z.string() }))
      .parse(await tx`SELECT id,title,aliases,summary,status FROM assistant.knowledge_nodes WHERE workspace_id=${workspace} AND id=ANY(${tx.array(items.map(i => i.node_id))}::uuid[]) ORDER BY id FOR UPDATE`);
    const byNode = new Map(rows.map(r => [r.id, r]));
    for (const item of items) {
      const row = byNode.get(item.node_id);
      if (!row || row.status === 'merged' || await sha256Hex(embedText(row)) !== item.sha256) { stale.push(item.node_id); continue; }
      await tx`UPDATE assistant.knowledge_nodes SET embedding=${JSON.stringify(Vector.parse(item.vector))}::vector,embedded_sha256=${item.sha256} WHERE workspace_id=${workspace} AND id=${item.node_id}`;
      stored.push(item.node_id);
    }
    return { stored, stale };
  });
}
/** Cosine top-k over embedded, non-merged nodes of the workspace (pgvector HNSW, iterative scan). */
/** Stored node vectors (live nodes with an embedding matching their current text). Used by the growth worker for descent/merge/split. */
export async function readVectors(sql: Query, workspace: string, ids?: readonly string[]): Promise<{ id: string; sha256: string; vector: number[] }[]> {
  const rows = await sql`SELECT id,embedded_sha256 AS sha256,embedding::text AS vector FROM assistant.knowledge_nodes WHERE workspace_id=${workspace} AND status<>'merged' AND embedding IS NOT NULL ${ids ? sql`AND id=ANY(${sql.array([...ids])}::uuid[])` : sql``}`;
  return z.array(z.object({ id: z.uuid(), sha256: z.string(), vector: z.string() })).parse(rows).map(r => ({ id: r.id, sha256: r.sha256, vector: Vector.parse(JSON.parse(r.vector)) }));
}
export async function denseSearch(sql: Database, workspace: string, vector: readonly number[], limit = SEARCH_LIMIT): Promise<{ id: string; score: number }[]> {
  const query = JSON.stringify(Vector.parse(vector));
  return sql.begin(async tx => {
    await tx`SET LOCAL hnsw.iterative_scan = relaxed_order`;
    await tx`SET LOCAL hnsw.ef_search = 100`;
    return z.array(z.object({ id: z.uuid(), score: z.coerce.number().finite() })).parse(await tx`SELECT id,1-(embedding <=> ${query}::vector) AS score FROM assistant.knowledge_nodes WHERE workspace_id=${workspace} AND status<>'merged' AND embedding IS NOT NULL ORDER BY embedding <=> ${query}::vector,id LIMIT ${limit}`);
  });
}

// ---------- queue ----------
const QueueRow = z.object({ user_message_id: z.uuid(), conversation_id: z.uuid(), sequence: num, attempts: num, claim_id: z.uuid(), claimed_until: z.unknown() });
const lockQueue = (tx: Transaction, workspace: string) => tx`SELECT pg_advisory_xact_lock(hashtextextended(${lockKey(workspace, 'knowledge-queue')},0))`;

export async function enqueue(sql: Query, workspace: string, userMessage: string): Promise<{ created: boolean; state: string }> {
  const rows = await sql`INSERT INTO assistant.knowledge_tree_queue(workspace_id,user_message_id,conversation_id,sequence)
    SELECT workspace_id,id,conversation_id,sequence FROM assistant.messages WHERE workspace_id=${workspace} AND id=${userMessage} AND role='user' AND NOT synthetic
    ON CONFLICT(workspace_id,user_message_id) DO NOTHING RETURNING state`;
  if (rows[0]) return { created: true, state: z.object({ state: z.string() }).parse(rows[0]).state };
  const existing = (await sql`SELECT state FROM assistant.knowledge_tree_queue WHERE workspace_id=${workspace} AND user_message_id=${userMessage}`)[0];
  if (!existing) throw new DomainError('invalid_source', 'Only real user messages of this workspace can be queued', 409);
  return { created: false, state: z.object({ state: z.string() }).parse(existing).state };
}
/** Set-based backfill used by scripts/knowledge-tree-backfill.ts; idempotent. Returns inserted row count per workspace. */
export async function enqueueBackfill(sql: Query, workspace: string): Promise<number> {
  const rows = await sql`INSERT INTO assistant.knowledge_tree_queue(workspace_id,user_message_id,conversation_id,sequence)
    SELECT workspace_id,id,conversation_id,sequence FROM assistant.messages WHERE workspace_id=${workspace} AND role='user' AND NOT synthetic ORDER BY sequence
    ON CONFLICT(workspace_id,user_message_id) DO NOTHING RETURNING 1`;
  return rows.length;
}
async function claimWorkspace(sql: Database, workspace: string): Promise<QueueItem | null> {
  return sql.begin(async tx => {
    await lockQueue(tx, workspace);
    // Strict per-workspace order: only the lowest-sequence open (pending or claimed) item can run; parked items are skipped.
    const head = (await tx`SELECT id,state,claimed_until > now() AS leased,retry_at <= now() AS due FROM assistant.knowledge_tree_queue WHERE workspace_id=${workspace} AND state IN ('pending','claimed') ORDER BY sequence LIMIT 1`)[0];
    if (!head) return null;
    const h = z.object({ id: z.coerce.number(), state: z.string(), leased: z.boolean().nullable(), due: z.boolean() }).parse(head);
    if (h.state === 'claimed' && h.leased) return null;
    if (h.state === 'pending' && !h.due) return null;
    const claim = crypto.randomUUID();
    const row = (await tx`UPDATE assistant.knowledge_tree_queue SET state='claimed',attempts=attempts+1,claim_id=${claim},claimed_until=now()+${`${QUEUE_LEASE_MS} milliseconds`}::interval,updated_at=now() WHERE id=${h.id}
      RETURNING user_message_id,conversation_id,sequence,attempts,claim_id,claimed_until`)[0];
    const r = QueueRow.parse(row);
    return { user_message_id: r.user_message_id, conversation_id: r.conversation_id, sequence: r.sequence, attempts: r.attempts, claim_id: r.claim_id, claimed_until: iso(r.claimed_until) };
  });
}
/**
 * Claims the next item. With a workspace, only that workspace is considered; with null every workspace with open items is
 * tried (workspaces holding an active lease are skipped). An expired lease is re-claimed and counts as an attempt.
 */
export async function claimNext(sql: Database, workspace: string | null): Promise<QueueItem | null> {
  if (workspace) return claimWorkspace(sql, workspace);
  const rows = z.array(z.object({ workspace_id: z.uuid() })).parse(await sql`SELECT workspace_id FROM assistant.knowledge_tree_queue WHERE state IN ('pending','claimed') GROUP BY workspace_id ORDER BY min(sequence) LIMIT 32`);
  for (const row of rows) { const item = await claimWorkspace(sql, row.workspace_id); if (item) return item; }
  return null;
}
export async function finish(sql: Database, workspace: string, userMessage: string, claim: string): Promise<void> {
  const rows = await sql.begin(async tx => { await lockQueue(tx, workspace); return tx`UPDATE assistant.knowledge_tree_queue SET state='done',claimed_until=NULL,claim_id=NULL,last_error=NULL,updated_at=now() WHERE workspace_id=${workspace} AND user_message_id=${userMessage} AND state='claimed' AND claim_id=${claim} RETURNING 1`; });
  if (!rows.length) throw new DomainError('stale_claim', 'Queue claim is no longer held', 409);
}
/** Transient failure: exponential wait; after QUEUE_MAX_ATTEMPTS the item is parked (ownerless, needs reprocessing) and the queue moves on. */
export async function fail(sql: Database, workspace: string, userMessage: string, claim: string, error: string): Promise<{ state: 'pending' | 'parked'; attempts: number; retry_at: string }> {
  return sql.begin(async tx => {
    await lockQueue(tx, workspace);
    const row = (await tx`SELECT attempts FROM assistant.knowledge_tree_queue WHERE workspace_id=${workspace} AND user_message_id=${userMessage} AND state='claimed' AND claim_id=${claim} FOR UPDATE`)[0];
    if (!row) throw new DomainError('stale_claim', 'Queue claim is no longer held', 409);
    const attempts = z.object({ attempts: num }).parse(row).attempts;
    const parked = attempts >= QUEUE_MAX_ATTEMPTS, wait = parked ? 0 : queueBackoffMs(attempts);
    const updated = z.object({ retry_at: z.unknown() }).parse((await tx`UPDATE assistant.knowledge_tree_queue SET state=${parked ? 'parked' : 'pending'},claimed_until=NULL,claim_id=NULL,last_error=${error.slice(0, 2000)},retry_at=now()+${`${wait} milliseconds`}::interval,updated_at=now() WHERE workspace_id=${workspace} AND user_message_id=${userMessage} RETURNING retry_at`)[0]);
    return { state: parked ? 'parked' as const : 'pending' as const, attempts, retry_at: iso(updated.retry_at) };
  });
}
/**
 * Removes exchanges from the tree (memory deletion / suppression): memberships, facts and links citing them, and nodes
 * left empty. Their queue rows are marked done so they are not grown again. Logged as one `forget` operation.
 */
export async function forget(sql: Database, workspace: string, userMessageIds: readonly string[]): Promise<{ touched: string[]; removed: string[] }> {
  if (!userMessageIds.length) return { touched: [], removed: [] };
  return sql.begin(tx => forgetIn(tx, workspace, userMessageIds));
}
/** Same as `forget`, inside the caller's transaction (e.g. the memory-deletion transaction). Only user messages matter. */
export async function forgetIn(tx: Transaction, workspace: string, messageIds: readonly string[]): Promise<{ touched: string[]; removed: string[] }> {
  await tx`SELECT pg_advisory_xact_lock(hashtextextended(${lockKey(workspace, 'knowledge-tree')},0))`;
  const users = z.array(z.object({ id: z.uuid() })).parse(await tx`SELECT id FROM assistant.messages WHERE workspace_id=${workspace} AND role='user' AND id=ANY(${tx.array([...messageIds])}::uuid[])`).map(r => r.id);
  if (!users.length) return { touched: [], removed: [] };
  // Not grown yet: never grow it.
  await tx`UPDATE assistant.knowledge_tree_queue SET state='done',claim_id=NULL,claimed_until=NULL,last_error='forgotten',updated_at=now() WHERE workspace_id=${workspace} AND user_message_id=ANY(${tx.array(users)}::uuid[]) AND state<>'done'`;
  const current = await readSnapshot(tx, workspace);
  const cited = new Set([...current.nodes.flatMap(n => n.summary.flatMap(f => f.evidence.map(e => e.user_message_id))), ...current.links.flatMap(l => l.evidence.map(e => e.user_message_id))]);
  const targets = users.filter(id => current.processed.includes(id) || cited.has(id) || current.nodes.some(n => n.mentions.includes(id)));
  if (!targets.length) return { touched: [], removed: [] };
  const result = forgetExchanges(current, targets), removed = new Set(result.removed);
  await tx`DELETE FROM assistant.knowledge_node_members WHERE workspace_id=${workspace} AND user_message_id=ANY(${tx.array(targets)}::uuid[])`;
  await tx`DELETE FROM assistant.knowledge_noise WHERE workspace_id=${workspace} AND user_message_id=ANY(${tx.array(targets)}::uuid[])`;
  await tx`DELETE FROM assistant.knowledge_entities WHERE workspace_id=${workspace} AND user_message_id=ANY(${tx.array(targets)}::uuid[])`;
  if (removed.size) {
    const ids = [...removed];
    await tx`DELETE FROM assistant.knowledge_links WHERE workspace_id=${workspace} AND (from_node=ANY(${tx.array(ids)}::uuid[]) OR to_node=ANY(${tx.array(ids)}::uuid[]))`;
    await tx`DELETE FROM assistant.knowledge_node_members WHERE workspace_id=${workspace} AND node_id=ANY(${tx.array(ids)}::uuid[])`;
    await tx`SET CONSTRAINTS ALL DEFERRED`;
    await tx`DELETE FROM assistant.knowledge_nodes WHERE workspace_id=${workspace} AND id=ANY(${tx.array(ids)}::uuid[])`;
  }
  await persist(tx, workspace, { ...current, nodes: current.nodes.filter(n => !removed.has(n.id)), links: current.links.filter(l => !removed.has(l.from) && !removed.has(l.to)) }, result.state, result.touched);
  const before = current.nodes.filter(n => removed.has(n.id) || result.touched.includes(n.id)), after = result.state.nodes.filter(n => result.touched.includes(n.id));
  await tx`INSERT INTO assistant.knowledge_ops(workspace_id,user_message_id,op,before,after) VALUES(${workspace},${null},${'forget'},${JSON.stringify({ forgotten: targets, nodes: before })}::text::jsonb,${JSON.stringify({ nodes: after, removed: [...removed] })}::text::jsonb)`;
  return { touched: result.touched, removed: [...removed] };
}
/** Gives a claim back without counting an attempt (the worker chose not to process it now, e.g. model pin mismatch). */
export async function release(sql: Database, workspace: string, userMessage: string, claim: string): Promise<void> {
  const rows = await sql.begin(async tx => { await lockQueue(tx, workspace); return tx`UPDATE assistant.knowledge_tree_queue SET state='pending',attempts=GREATEST(attempts-1,0),claimed_until=NULL,claim_id=NULL,retry_at=now()+interval '60 seconds',updated_at=now() WHERE workspace_id=${workspace} AND user_message_id=${userMessage} AND state='claimed' AND claim_id=${claim} RETURNING 1`; });
  if (!rows.length) throw new DomainError('stale_claim', 'Queue claim is no longer held', 409);
}
/** Moves parked items back to pending (operator action after the cause is fixed). */
export async function requeueParked(sql: Query, workspace: string): Promise<number> {
  return (await sql`UPDATE assistant.knowledge_tree_queue SET state='pending',attempts=0,retry_at=now(),updated_at=now() WHERE workspace_id=${workspace} AND state='parked' RETURNING 1`).length;
}
export async function queueStatus(sql: Query, workspace: string): Promise<QueueStatus> {
  const rows = z.array(z.object({ state: z.string(), n: num })).parse(await sql`SELECT state,count(*) AS n FROM assistant.knowledge_tree_queue WHERE workspace_id=${workspace} GROUP BY state`);
  const count = (s: string) => rows.find(r => r.state === s)?.n ?? 0;
  return { pending: count('pending'), claimed: count('claimed'), done: count('done'), parked: count('parked') };
}
