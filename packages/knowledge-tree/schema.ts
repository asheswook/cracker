/**
 * Knowledge tree contracts shared by the control service and the daemon.
 *
 * ── Exported API summary (packages/knowledge-tree/*) ───────────────────────────────────────────
 * schema.ts   zod: Evidence, Fact, Node, Member, Link, Snapshot, Op (+ per-op schemas), ApplyRequest, ApplyResult,
 *             ClefRaw, ClefRequest, SearchRequest, SearchResult, EmbedRequest/EmbedResult, SourcesRequest/SourcesResult,
 *             QueueItem, Enqueue/Claim/Finish/Fail requests, QueueStatus, TreeSelection, KnowledgeTreeMode, constants.
 * core.ts     (pure) theta(depth), isNoise, cosine, rrf(lists), rrfCandidates(state,kw,dense), keywordRank(state,text),
 *             selectNodes({rrfTop,clef,aux}), clefCandidates/clefInput/clefChoiceIds, descend, mergeCandidates, sweepPairs,
 *             parentClusters, crossLinkCandidates, proposeSplit/agglomerate/silhouette, state helpers (live, byId, children,
 *             ancestors, descendants, rootOf, members, ownerNodeOf, nodeText, embedText, sha256Hex, emptyState),
 *             applyOps(state, ops, ctx) → {state, touched, log}   — all-or-nothing, throws TreeError(code) on invariant violation,
 *             validateState(state), constants THETA0/MERGE_COS/…/SPLIT_MIN_OWNERS/SWEEP_EVERY.
 * deliver.ts  (pure) orderV3(state, selected, query, docs, cap, recent?), budgeted(ids, docs, budget),
 *             treeDeliveryPacket(state, selected, query, docs, opts) → TreePacket, renderTreePacket(packet) → string (JSON text block).
 * store.ts    (Postgres, take a `Database`) readSnapshot, applyOps, setEmbeddings, denseSearch, readSources,
 *             enqueue, claimNext, finish, fail, queueStatus, requeueParked, loadExchangeSources.
 *
 * ── Control routes (daemon auth, VM principal, run must be owned by the VM; all POST, JSON) ─────────
 * /v1/daemon/context/:run/tree/snapshot      {}                                    → Snapshot
 * /v1/daemon/context/:run/tree/search        {text}                                → SearchResult {ranking:[{id,score}] (top 48, cosine), embed_ms, search_ms}
 * /v1/daemon/context/:run/tree/embed         {items:[{node_id,text,sha256}] ≤32}   → EmbedResult {stored:[id], stale:[id], embed_ms}
 * /v1/daemon/context/:run/tree/clef          {incoming, recent_turns, candidates:[{option,text}] ≤24} → ClefRaw {choice, confidence, probabilities, ms}
 * /v1/daemon/context/:run/tree/apply         {user_message_id, ops, expected:{[node_id]:revision}} → ApplyResult {revisions, touched, logged}
 * /v1/daemon/context/:run/tree/sources       {user_message_ids ≤64}                → SourcesResult
 * /v1/daemon/context/:run/tree/queue/enqueue {user_message_id}                     → {created, state}
 * /v1/daemon/context/:run/tree/queue/claim   {}                                    → {item: QueueItem | null}
 * /v1/daemon/context/:run/tree/queue/finish  {user_message_id, claim_id}           → {ok}
 * /v1/daemon/context/:run/tree/queue/fail    {user_message_id, claim_id, error}    → {state:'pending'|'parked', attempts, retry_at}
 * /v1/daemon/context/:run/tree/queue/status  {}                                    → QueueStatus
 * 503 (code context_embedding_unavailable / clef_unavailable) when env.AI is missing or the model call fails/times out.
 * ──────────────────────────────────────────────────────────────────────────────────────────────────
 */
import { z } from 'zod';

export const KNOWLEDGE_EMBEDDING_DIMENSIONS = 1024;
export const SUMMARY_MAX_FACTS = 24;
export const SEARCH_LIMIT = 48;
export const CANDIDATE_LIMIT = 24;
/**
 * Clef decides alone at or above this confidence. Offline v3 (105 queries): at 0.35 Clef decides 74 instead of 52, and in
 * the added band its pick equals the auxiliary model's in 21/22, so accuracy is unchanged while fewer turns wait for it.
 */
export const CLEF_CONFIDENCE = 0.35;
export const CLEF_TIMEOUT_MS = 8000;
export const AUX_TIMEOUT_MS = 5000;
export const QUEUE_LEASE_MS = 10 * 60 * 1000;
export const QUEUE_MAX_ATTEMPTS = 8;
/** Retry wait after the n-th failed attempt (n = attempts already started, >= 1). */
export const queueBackoffMs = (attempts: number) => Math.min(300_000, 5_000 * 2 ** Math.min(attempts, 6));

export const KnowledgeTreeMode = z.enum(['off', 'shadow', 'on']);
export type KnowledgeTreeMode = z.infer<typeof KnowledgeTreeMode>;

const Id = z.uuid();
export const Evidence = z.object({ user_message_id: Id, message_id: Id, quote: z.string().min(1).max(1000) }).strict();
export type Evidence = z.infer<typeof Evidence>;
export const Fact = z.object({ text: z.string().min(1).max(500), evidence: z.array(Evidence).min(1).max(4) }).strict();
export type Fact = z.infer<typeof Fact>;
export const NodeKind = z.enum(['topic', 'rule', 'event']);
export type NodeKind = z.infer<typeof NodeKind>;
export const NodeStatus = z.enum(['active', 'archived', 'merged']);

/** A tree node. owners/mentions are the user_message_ids of its member exchanges (rows of knowledge_node_members). */
export const Node = z.object({
  id: Id, parent_id: Id.nullable(), kind: NodeKind, title: z.string().min(1).max(300), aliases: z.array(z.string().max(300)).max(16),
  summary: z.array(Fact).max(SUMMARY_MAX_FACTS), entities: z.array(z.string().max(200)).max(40),
  owners: z.array(Id), mentions: z.array(Id),
  status: NodeStatus, merged_into: Id.nullable(), depth: z.number().int().nonnegative(), revision: z.number().int().nonnegative(),
  embedded_sha256: z.string().regex(/^[a-f0-9]{64}$/).nullable(),
  created_sequence: z.number().int(), updated_sequence: z.number().int(),
}).strict();
export type Node = z.infer<typeof Node>;
export const Member = z.object({ node_id: Id, user_message_id: Id, role: z.enum(['owner', 'mention']) }).strict();
export type Member = z.infer<typeof Member>;
export const LinkKind = z.enum(['branch', 'part_of', 'reference', 'governs']);
export const Link = z.object({ from: Id, to: Id, kind: LinkKind, evidence: z.array(Evidence).min(1).max(4), confidence: z.number().min(0).max(1), revision: z.number().int().positive() }).strict();
export type Link = z.infer<typeof Link>;
/**
 * Whole workspace tree. `processed` lists every exchange (user message id) that has exactly one owner, ordered by message
 * sequence; `sequence` maps those ids to their message sequence; `noise` ⊆ processed; `entities` are per-exchange named targets.
 */
export const Snapshot = z.object({
  nodes: z.array(Node), links: z.array(Link), processed: z.array(Id), sequence: z.record(Id, z.number().int()),
  noise: z.array(Id), entities: z.record(Id, z.array(z.string())),
}).strict();
export type Snapshot = z.infer<typeof Snapshot>;
export type TreeState = Snapshot;

// ---------- operations (all-or-nothing batch) ----------
const Title = z.string().min(1).max(300);
const Aliases = z.array(z.string().max(300)).max(32);
const Entities = z.array(z.string().max(200)).max(40);
export const CreateNodeOp = z.object({ op: z.literal('create_node'), id: Id, kind: NodeKind, title: Title, aliases: Aliases.default([]), entities: Entities.default([]), parent_id: Id.nullable().default(null) }).strict();
export const AttachOp = z.object({ op: z.literal('attach'), node_id: Id, user_message_id: Id, noise: z.boolean().default(false), mentions: z.array(Id).max(16).default([]), entities: Entities.default([]) }).strict();
export const PatchSummaryOp = z.object({ op: z.literal('patch_summary'), node_id: Id, remove: z.array(z.number().int().nonnegative()).max(SUMMARY_MAX_FACTS).default([]), facts: z.array(Fact).max(SUMMARY_MAX_FACTS).default([]), aliases: Aliases.default([]) }).strict();
export const SetSummaryOp = z.object({ op: z.literal('set_summary'), node_id: Id, facts: z.array(Fact).max(SUMMARY_MAX_FACTS) }).strict();
export const MergeOp = z.object({ op: z.literal('merge'), from: Id, into: Id, summary: z.array(Fact).max(SUMMARY_MAX_FACTS).optional() }).strict();
export const SplitPart = z.object({ id: Id, title: Title, kind: NodeKind, aliases: Aliases.default([]), facts: z.array(Fact).max(SUMMARY_MAX_FACTS).default([]), owners: z.array(Id).min(1) }).strict();
export const SplitOp = z.object({ op: z.literal('split'), node_id: Id, parts: z.array(SplitPart).min(2).max(3) }).strict();
export const CreateParentOp = z.object({ op: z.literal('create_parent'), id: Id, member_ids: z.array(Id).min(2).max(8), title: Title, kind: NodeKind.default('topic'), aliases: Aliases.default([]), facts: z.array(Fact).max(SUMMARY_MAX_FACTS).default([]) }).strict();
export const AddLinkOp = z.object({ op: z.literal('add_link'), from: Id, to: Id, kind: LinkKind, evidence: z.array(Evidence).min(1).max(4), confidence: z.number().min(0).max(1) }).strict();
export const SetStatusOp = z.object({ op: z.literal('set_status'), node_id: Id, status: z.enum(['active', 'archived']) }).strict();
/** Reclassify a node (e.g. a fact wrongly filed as a rule). */
export const SetKindOp = z.object({ op: z.literal('set_kind'), node_id: Id, kind: NodeKind }).strict();
/** Move a node (with its subtree) under another parent, or to the top level with parent_id=null. */
export const SetParentOp = z.object({ op: z.literal('set_parent'), node_id: Id, parent_id: Id.nullable() }).strict();
/** Rename a node (title and aliases). */
export const SetTitleOp = z.object({ op: z.literal('set_title'), node_id: Id, title: Title, aliases: Aliases.default([]) }).strict();
/** Delete a node that owns no exchanges and has no live children (mentions and links to it are dropped). */
export const DropNodeOp = z.object({ op: z.literal('drop_node'), node_id: Id }).strict();
export const Op = z.discriminatedUnion('op', [CreateNodeOp, AttachOp, PatchSummaryOp, SetSummaryOp, MergeOp, SplitOp, CreateParentOp, AddLinkOp, SetStatusOp, SetKindOp, SetParentOp, SetTitleOp, DropNodeOp]);
export type Op = z.infer<typeof Op>;
export type OpInput = z.input<typeof Op>;
export const Ops = z.array(Op).min(1).max(64);

/** `expected` maps existing node ids this batch reads/writes to the revision the caller saw; any mismatch → 409 stale_revision. */
export const ApplyRequest = z.object({ user_message_id: Id, ops: Ops, expected: z.record(Id, z.number().int().nonnegative()).default({}) }).strict();
export type ApplyRequest = z.infer<typeof ApplyRequest>;
export const ApplyResult = z.object({ revisions: z.record(Id, z.number().int()), touched: z.array(Id), logged: z.number().int() }).strict();
export type ApplyResult = z.infer<typeof ApplyResult>;

// ---------- retrieval ----------
export const SearchRequest = z.object({ text: z.string().min(1).max(12000) }).strict();
export const SearchResult = z.object({ ranking: z.array(z.object({ id: Id, score: z.number() }).strict()).max(SEARCH_LIMIT), embed_ms: z.number(), search_ms: z.number() }).strict();
export type SearchResult = z.infer<typeof SearchResult>;
export const EmbedRequest = z.object({ items: z.array(z.object({ node_id: Id, text: z.string().min(1).max(8000), sha256: z.string().regex(/^[a-f0-9]{64}$/) }).strict()).min(1).max(32) }).strict();
/** Embeds arbitrary texts (exchange texts / queries for growth); nothing is stored. */
export const EmbedTextsRequest = z.object({ texts: z.array(z.string().min(1).max(8000)).min(1).max(32) }).strict();
export const EmbedTextsResult = z.object({ vectors: z.array(z.array(z.number())), embed_ms: z.number() }).strict();
/** Stored node vectors; omit node_ids for all live embedded nodes. */
export const VectorsRequest = z.object({ node_ids: z.array(Id).max(512).optional() }).strict();
export const VectorsResult = z.object({ vectors: z.array(z.object({ id: Id, sha256: z.string(), vector: z.array(z.number()) }).strict()) }).strict();
export const EmbedResult = z.object({ stored: z.array(Id), stale: z.array(Id), embed_ms: z.number() }).strict();
export type EmbedResult = z.infer<typeof EmbedResult>;
const Turn = z.object({ role: z.string().min(1).max(32), text: z.string().max(1200) }).strict();
export const ClefRequest = z.object({
  incoming: z.string().min(1).max(12000), recent_turns: z.array(Turn).max(6).default([]),
  candidates: z.array(z.object({ option: z.string().regex(/^context_[0-9]{1,2}$/), text: z.string().min(1).max(1400) }).strict()).min(1).max(CANDIDATE_LIMIT),
}).strict().refine(r => new Set(r.candidates.map(c => c.option)).size === r.candidates.length, 'duplicate_option');
export type ClefRequest = z.infer<typeof ClefRequest>;
/** Raw Clef answer. No confidence gate is applied here; `choice` is `uncertain` or one of the supplied options. */
export const ClefRaw = z.object({ choice: z.string(), confidence: z.number().min(0).max(1), probabilities: z.record(z.string(), z.number().min(0).max(1)), ms: z.number() }).strict();
export type ClefRaw = z.infer<typeof ClefRaw>;
/** Auxiliary model (gpt-6-luna / claude-haiku-5-5) node selection, validated by the daemon. */
export const TreeSelection = z.object({ node_ids: z.array(z.string()).max(3), confidence: z.number().min(0).max(1), rationale: z.string().max(300) }).strict();
export type TreeSelection = z.infer<typeof TreeSelection>;

export const SourcesRequest = z.object({ user_message_ids: z.array(Id).min(1).max(64) }).strict();
export const ExchangeSource = z.object({
  user_message_id: Id, conversation_id: Id.nullable(), sequence: z.number().int().nullable(),
  /** false when the exchange is missing, synthetic or its retention decision is denied/pending; `messages` is then empty. */
  allowed: z.boolean(),
  messages: z.array(z.object({ message_id: Id, role: z.enum(['user', 'assistant']), sequence: z.number().int(), text: z.string() }).strict()),
}).strict();
export type ExchangeSource = z.infer<typeof ExchangeSource>;
export const SourcesResult = z.object({ exchanges: z.array(ExchangeSource) }).strict();
export type SourcesResult = z.infer<typeof SourcesResult>;

// ---------- queue ----------
export const QueueItem = z.object({ user_message_id: Id, conversation_id: Id, sequence: z.number().int(), attempts: z.number().int(), claim_id: Id, claimed_until: z.string() }).strict();
export type QueueItem = z.infer<typeof QueueItem>;
export const EnqueueRequest = z.object({ user_message_id: Id }).strict();
export const FinishRequest = z.object({ user_message_id: Id, claim_id: Id }).strict();
export const FailRequest = z.object({ user_message_id: Id, claim_id: Id, error: z.string().max(2000) }).strict();
export const QueueStatus = z.object({ pending: z.number().int(), claimed: z.number().int(), done: z.number().int(), parked: z.number().int() }).strict();
export type QueueStatus = z.infer<typeof QueueStatus>;
