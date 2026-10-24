/**
 * Background knowledge-tree growth for one exchange:
 * noise → top-down descent + BM25 + previous node candidates → attach/create (LLM) → summary patch + ancestor rewrites
 * → code-generated merge candidates (LLM yes/no) → split (≥12 owners, clustering + LLM confirm) → cross links
 * → every SWEEP_EVERY exchanges: sweep merges + RAPTOR parents. Every step produces ops that the server applies
 * atomically with invariant + exact-quote checks; optional steps that fail validation are skipped, never fatal.
 */
import { z } from 'zod';
import type { Provider } from '../../packages/provider/index.ts';
import {
  ancestors, applyOps, askedRecently, byId, candidateNodes, children, crossLinkCandidates, descend, embedText, isNoise, live, MAX_ANCESTORS,
  members, mergeCandidates, ownerNodeOf, parentClusters, proposeSplit, QUERY_CHARS, remember, sha256Hex, SPLIT_MIN_OWNERS, sweepPairs, SWEEP_EVERY, unique,
  keywordRank, type PairScore, type TreeState,
} from '../../packages/knowledge-tree/core.ts';
import type { ExchangeSource, Fact, Node, OpInput, Snapshot } from '../../packages/knowledge-tree/schema.ts';
import type { TreeClient } from './knowledge-tree-client.ts';
import { askTree, TreeValidationExhausted } from './knowledge-tree-llm.ts';

// ---------- LLM schemas (identical to the offline replay) ----------
const LEvidence = z.object({ message_id: z.string(), quote: z.string().min(1).max(400) }).strict();
const LFact = z.object({ text: z.string().min(1).max(500), evidence: z.array(LEvidence).min(1).max(2) }).strict();
type LFact = z.infer<typeof LFact>;
const Attach = z.object({
  action: z.enum(['attach', 'create']), owner_id: z.string().nullable(), parent_id: z.string().nullable(),
  title: z.string().max(160), kind: z.enum(['topic', 'rule', 'event']), aliases: z.array(z.string().max(80)).max(6),
  entities: z.array(z.string().max(60)).max(8), mentions: z.array(z.string()).max(3), rationale: z.string().max(300),
}).strict();
const Patch = z.object({ remove_fact_indexes: z.array(z.number().int().nonnegative()).max(12), facts: z.array(LFact).max(3), add_aliases: z.array(z.string().max(80)).max(4), rationale: z.string().max(300) }).strict();
const Rewrite = z.object({ facts: z.array(LFact).min(1).max(8), rationale: z.string().max(300) }).strict();
const Same = z.object({ same_topic: z.boolean(), rationale: z.string().max(300) }).strict();
const MergeSummary = z.object({ title: z.string().min(1).max(160), aliases: z.array(z.string().max(80)).max(6), facts: z.array(LFact).min(1).max(12) }).strict();
const SplitConfirm = z.object({
  split: z.boolean(), rationale: z.string().max(300),
  parts: z.array(z.object({ cluster: z.number().int().nonnegative(), title: z.string().max(160), kind: z.enum(['topic', 'rule', 'event']), aliases: z.array(z.string().max(80)).max(6), facts: z.array(LFact).max(3) }).strict()).max(3),
}).strict();
const ParentConfirm = z.object({ share_parent: z.boolean(), title: z.string().max(160), aliases: z.array(z.string().max(80)).max(6), facts: z.array(LFact).max(5), rationale: z.string().max(300) }).strict();
const LinkConfirm = z.object({ decisions: z.array(z.object({ index: z.number().int().nonnegative(), link: z.boolean() }).strict()).max(10) }).strict();

const HANGUL = /[가-힣]/u;
const hangulRatio = (t: string) => { const letters = [...t].filter(c => /\p{L}/u.test(c)); return letters.length ? letters.filter(c => HANGUL.test(c)).length / letters.length : 0; };
const pairsOf = (facts: readonly Fact[]) => facts.flatMap(f => f.evidence.map(e => JSON.stringify([e.message_id, e.quote])));
const renderFacts = (facts: readonly Fact[]) => facts.map((f, i) => ({ index: i, text: f.text, evidence: f.evidence.map(e => ({ message_id: e.message_id, quote: e.quote })) }));

export type GrowthLog = { node: string; created: boolean; noise: boolean; ops: Record<string, number>; llm: number };
type Ctx = {
  client: TreeClient; provider: Provider; signal: AbortSignal; memo: Record<string, number>;
  user: string; sequence: number; index: number;
  /** message id → {exchange (user_message_id), full text} for every message the LLM may quote. */
  texts: Map<string, { exchange: string; text: string }>;
  exchange: Map<string, ExchangeSource>;
  vec: Map<string, number[]>; exVec: Map<string, number[]>;
  ops: Record<string, number>; llm: number;
};
const bump = (c: Ctx, k: string, n = 1) => { c.ops[k] = (c.ops[k] ?? 0) + n; };
const vecOf = (c: Ctx) => (id: string) => c.vec.get(id);

/** Converts LLM evidence ({message_id, quote}) into stored evidence with its exchange id. Throws on unknown message ids. */
function lift(c: Ctx, f: LFact): Fact {
  return { text: f.text.slice(0, 500), evidence: f.evidence.map(e => { const t = c.texts.get(e.message_id); if (!t) throw new Error(`unknown_message:${e.message_id}`); return { user_message_id: t.exchange, message_id: e.message_id, quote: e.quote }; }) };
}
function checker(c: Ctx, inherited: ReadonlySet<string>) {
  return (f: LFact) => { for (const e of f.evidence) if (!(c.texts.get(e.message_id)?.text.includes(e.quote) || inherited.has(JSON.stringify([e.message_id, e.quote])))) throw new Error(`quote_not_in_supplied_text:${e.message_id}`); };
}
async function loadSources(c: Ctx, ids: readonly string[]) {
  const missing = unique(ids).filter(id => !c.exchange.has(id));
  for (let i = 0; i < missing.length; i += 64) {
    const r = await c.client.sources(missing.slice(i, i + 64), c.signal);
    for (const e of r.exchanges) {
      c.exchange.set(e.user_message_id, e);
      for (const m of e.messages) c.texts.set(m.message_id, { exchange: e.user_message_id, text: m.text });
    }
  }
}
const userLine = (c: Ctx, id: string) => c.exchange.get(id)?.messages.find(m => m.role === 'user')?.text.split('\n')[0]?.slice(0, 160) ?? '';
function exchangeText(c: Ctx, id: string, limit = QUERY_CHARS) {
  const ms = c.exchange.get(id)?.messages ?? [];
  return `${ms.filter(m => m.role === 'user').map(m => m.text).join('\n')}\n\n${ms.filter(m => m.role !== 'user').map(m => m.text).join('\n')}`.slice(0, limit);
}
async function exchangeVecs(c: Ctx, ids: readonly string[]) {
  const missing = unique(ids).filter(id => !c.exVec.has(id) && exchangeText(c, id).trim());
  for (let i = 0; i < missing.length; i += 32) {
    const batch = missing.slice(i, i + 32), r = await c.client.embedTexts(batch.map(id => exchangeText(c, id)), c.signal);
    batch.forEach((id, j) => { const v = r.vectors[j]; if (v) c.exVec.set(id, v); });
  }
  return ids.map(id => c.exVec.get(id));
}
/** Embeds live nodes whose stored vector is missing or stale (text changed), persisting them server-side. */
async function refreshVecs(c: Ctx, s: TreeState) {
  const stale: { node_id: string; text: string; sha256: string }[] = [];
  for (const n of live(s)) { const text = embedText(n), sha = await sha256Hex(text); if (n.embedded_sha256 !== sha || !c.vec.has(n.id)) stale.push({ node_id: n.id, text, sha256: sha }); }
  for (let i = 0; i < stale.length; i += 32) {
    const batch = stale.slice(i, i + 32), r = await c.client.embedTexts(batch.map(b => b.text), c.signal);
    batch.forEach((b, j) => { const v = r.vectors[j]; if (v) c.vec.set(b.node_id, v); });
    await c.client.embed(batch, c.signal).catch(() => undefined);
    for (const b of batch) { const n = byId(s, b.node_id); if (n) n.embedded_sha256 = b.sha256; }
  }
}
function render(c: Ctx, s: TreeState, n: Node, detail = true) {
  const parent = n.parent_id ? byId(s, n.parent_id) : null;
  return { id: n.id, kind: n.kind, title: n.title, aliases: n.aliases, depth: n.depth, parent: parent ? { id: parent.id, title: parent.title } : null, owner_count: members(s, n).length, entities: n.entities.slice(-8), ...(detail ? { summary: n.summary.map(f => f.text), recent_owner_lines: n.owners.slice(-2).map(id => userLine(c, id).slice(0, 120)) } : {}) };
}
async function ask<T>(c: Ctx, spec: Parameters<typeof askTree<T>>[1]) { c.llm++; return askTree(c.provider, spec, c.signal); }
async function optional<T>(c: Ctx, name: string, fn: () => Promise<T>): Promise<T | null> {
  try { return await fn(); }
  catch (error) { if (c.signal.aborted) throw error; if (error instanceof TreeValidationExhausted || (error instanceof Error && /^unknown_message|quote_not/.test(error.message))) { bump(c, `fail_${name}`); return null; } throw error; }
}
/** Applies ops locally (same pure function as the server) and then on the server; on a local invariant failure the step is skipped. */
async function commit(c: Ctx, s: TreeState, name: string, ops: OpInput[], expectIds: readonly string[]): Promise<boolean> {
  const texts = new Map([...c.texts].map(([id, t]) => [id, t.text]));
  let next: TreeState;
  try { next = applyOps(s, ops.map(o => o as never), { user_message_id: c.user, sequence: c.sequence, texts }).state; }
  catch { bump(c, `fail_${name}`); return false; }
  const expected = Object.fromEntries(unique(expectIds).flatMap(id => { const n = byId(s, id); return n ? [[id, n.revision] as const] : []; }));
  await c.client.apply(c.user, ops, expected, c.signal);
  Object.assign(s, next);
  return true;
}

// ---------- steps ----------
async function insert(c: Ctx, s: TreeState) {
  const ex = c.exchange.get(c.user)!, text = exchangeText(c, c.user), prev = s.processed.at(-1);
  const [qv] = await exchangeVecs(c, [c.user]);
  await refreshVecs(c, s);
  const cands = new Map<string, string>();
  if (qv) for (const d of descend(s, qv, vecOf(c), { top: 4 }).filter(d => candidateNodes(s).some(n => n.id === d.id)).slice(0, 3)) cands.set(d.id, 'descent');
  for (const r of keywordRank(s, text).filter(x => x.score > 0).slice(0, 3)) cands.set(r.id, cands.has(r.id) ? `${cands.get(r.id)}+bm25` : 'bm25');
  const prevNode = prev ? ownerNodeOf(s, prev) : undefined;
  if (prevNode && prevNode.status !== 'merged') cands.set(prevNode.id, cands.has(prevNode.id) ? `${cands.get(prevNode.id)}+previous` : 'previous');
  const candidateIds = [...cands.keys()];
  const parentOk = unique(candidateIds.flatMap(id => [id, ...ancestors(s, id).map(a => a.id)])).filter(id => byId(s, id)?.kind !== 'rule');
  const newId = crypto.randomUUID();
  const userText = ex.messages.filter(m => m.role === 'user').map(m => m.text).join('\n'), korean = hangulRatio(userText) > 0.3;
  let a: z.infer<typeof Attach> | null = null;
  try {
    a = await ask(c, {
      name: 'tree_attach', schema: Attach,
      data: { current_exchange: ex.messages.map(m => ({ message_id: m.message_id, role: m.role, text: m.text.slice(0, 3000) })), recent: s.processed.slice(-3).map(id => ({ exchange_id: id, user_line: userLine(c, id) })), new_node_id: newId, allowed_parent_ids: parentOk, candidates: candidateIds.map(id => ({ ...render(c, s, byId(s, id)!), found_by: cands.get(id) })) },
      instruction: `You maintain a persistent HIERARCHICAL topic tree of one user's conversations. Choose ONE owner node for the completed current exchange, or create a new node.
- action=attach: owner_id must be a candidate id; use it when the exchange continues or returns to that node's subject (same person's catch-up across days, same schedule unit, same investigation or product discussion belong together). Prefer the most specific candidate that fits.
- action=create: owner_id=null; title = short name the user would later use, written in the wording and language actually used in the conversation (keep English proper nouns, product and company names as written; never translate or rewrite into another language). parent_id = a candidate id or one of allowed_parent_ids ONLY if the new subject is a sub-aspect or branch of that parent topic; otherwise null. kind=rule ONLY for a standing instruction from the user about how the assistant must behave from now on (preferences, procedures, defaults such as "always book rooms near the 17th floor"); facts, legal/regulatory criteria, research findings and conclusions are NEVER rules, even when they read like criteria — they are topics. Rules stay separate from events; a single scheduled/one-off action is kind=event; otherwise topic.
- aliases: other surface forms that literally appear in the exchange (never invented). entities: up to 8 people, organizations, products or dates literally named (original spelling). mentions: other candidate ids merely referenced.
Return rationale briefly, no chain-of-thought.`,
      check: v => {
        if (v.action === 'attach') { if (!v.owner_id || !candidateIds.includes(v.owner_id)) throw new Error('attach_needs_candidate_owner_id'); }
        else {
          if (v.owner_id !== null || !v.title.trim()) throw new Error('create_needs_null_owner_and_title');
          if (v.parent_id !== null && !parentOk.includes(v.parent_id)) throw new Error('parent_not_allowed');
          if (korean && !HANGUL.test(v.title) && !userText.toLowerCase().includes(v.title.toLowerCase())) throw new Error('title_must_follow_conversation_wording_korean');
        }
        if (v.mentions.some(x => !candidateIds.includes(x))) throw new Error('unknown_mention');
      },
    });
  } catch (error) { if (!(error instanceof TreeValidationExhausted)) throw error; bump(c, 'fallback_create'); }
  const haystack = `${userText}\n${text}`.toLowerCase();
  const aliases = (a?.aliases ?? []).filter(x => haystack.includes(x.toLowerCase()));
  const ops: OpInput[] = [];
  let target: string, created = false;
  if (!a || a.action === 'create') {
    target = newId; created = true;
    ops.push({ op: 'create_node', id: newId, kind: a?.kind ?? 'topic', title: (a?.title.trim() || userText.trim().slice(0, 40) || '대화').slice(0, 300), aliases, entities: a?.entities ?? [], parent_id: a?.parent_id ?? null });
    bump(c, 'create'); if (a?.parent_id) bump(c, 'create_child');
  } else { target = a.owner_id!; bump(c, 'attach'); if (aliases.length) ops.push({ op: 'patch_summary', node_id: target, remove: [], facts: [], aliases }); }
  ops.push({ op: 'attach', node_id: target, user_message_id: c.user, noise: false, mentions: (a?.mentions ?? []).filter(m => m !== target), entities: a?.entities ?? [] });
  if (!await commit(c, s, 'attach', ops, [...(created ? [] : [target]), ...(a?.mentions ?? []), ...(a?.parent_id ? [a.parent_id] : [])])) throw new Error('attach_rejected');
  return { target, created, entities: a?.entities ?? [] };
}

async function summaries(c: Ctx, s: TreeState, target: string) {
  const n = byId(s, target)!, anc = ancestors(s, target).slice(0, MAX_ANCESTORS);
  const ex = (c.exchange.get(c.user)?.messages ?? []).map(m => ({ message_id: m.message_id, text: m.text.slice(0, 3000) }));
  const priorIds = n.owners.filter(o => o !== c.user).slice(-3);
  await loadSources(c, priorIds);
  const prior = priorIds.flatMap(o => (c.exchange.get(o)?.messages ?? []).map(m => ({ message_id: m.message_id, role: m.role, text: m.text.slice(0, 1200) })));
  const patch = optional(c, 'patch', () => ask(c, {
    name: 'tree_summary_patch', schema: Patch,
    data: { node: { ...render(c, s, n, false), summary: renderFacts(n.summary) }, current_exchange: ex, earlier_exchanges: prior },
    instruction: `Update this node's summary incrementally after the current exchange. Return a PATCH: remove_fact_indexes = zero-based indexes into the supplied summary of facts that are superseded, corrected (including advice edits) or redundant; facts = at most 3 NEW concise facts (<=200 chars each, in the language used in the conversation) with 1-2 evidence entries {message_id, quote}; quote must be an exact substring of the supplied text of that message_id. Keep the summary at about 12 facts or fewer by consolidating (hard cap 20). Corrected facts MUST be removed before adding the latest version. add_aliases: surface forms that literally occur in the text. Do not invent. Brief rationale.`,
    check: v => { const ok = checker(c, new Set(pairsOf(n.summary))); v.facts.forEach(ok); if (unique(v.remove_fact_indexes).length !== v.remove_fact_indexes.length || v.remove_fact_indexes.some(i => i >= n.summary.length)) throw new Error('invalid_fact_index'); if (n.summary.length - v.remove_fact_indexes.length + v.facts.length > 20) throw new Error('summary_over_20_facts: remove or consolidate more'); },
  }));
  const rewrites = anc.map(a => optional(c, 'ancestor', () => {
    const kids = children(s, a.id), inherited = new Set([...pairsOf(a.summary), ...kids.flatMap(k => pairsOf(k.summary))]);
    return ask(c, {
      name: 'tree_ancestor_summary', schema: Rewrite,
      data: { ancestor: { ...render(c, s, a, false), summary: renderFacts(a.summary) }, children: kids.map(k => ({ id: k.id, title: k.title, summary: renderFacts(k.summary.slice(-6)) })), current_exchange: ex, touched_child_or_descendant: target },
      instruction: `Rewrite the summary of this ANCESTOR node concisely (3-8 facts, <=200 chars each, in the conversation's language) so that it gives an overview of the whole branch beneath it, reflecting the current exchange and the children summaries. Newest corrected facts win; drop superseded ones. Each fact needs 1-2 evidence entries {message_id, quote} where quote is an exact substring of a supplied current-exchange text OR copied exactly from a supplied children/ancestor evidence entry. Do not invent.`,
      check: v => v.facts.forEach(checker(c, inherited)),
    });
  }));
  // Inherited evidence from existing facts is quotable too: register its texts.
  for (const f of [...n.summary, ...anc.flatMap(a => [...a.summary, ...children(s, a.id).flatMap(k => k.summary)])]) for (const e of f.evidence) if (!c.texts.has(e.message_id)) c.texts.set(e.message_id, { exchange: e.user_message_id, text: e.quote });
  const [p, ...rs] = await Promise.all([patch, ...rewrites]);
  if (p) {
    const facts = p.facts.map(f => lift(c, f)), userText = (c.exchange.get(c.user)?.messages.find(m => m.role === 'user')?.text ?? '').toLowerCase();
    if (await commit(c, s, 'patch', [{ op: 'patch_summary', node_id: target, remove: p.remove_fact_indexes, facts, aliases: p.add_aliases.filter(a => userText.includes(a.toLowerCase())) }], [target])) bump(c, 'summary_patch');
  }
  for (const [i, r] of rs.entries()) {
    const a = anc[i]; if (!r || !a) continue;
    if (await commit(c, s, 'ancestor', [{ op: 'set_summary', node_id: a.id, facts: r.facts.map(f => lift(c, f)) }], [a.id])) bump(c, 'ancestor_rewrite');
  }
}

async function confirmMerges(c: Ctx, s: TreeState, pairs: PairScore[], limit: number) {
  const todo = pairs.filter(p => !askedRecently(s, c.memo, 'merge', p.a, p.b)).slice(0, limit);
  const answers = await Promise.all(todo.map(p => optional(c, 'same_topic', () => ask(c, {
    name: 'tree_same_topic', schema: Same, data: { a: render(c, s, byId(s, p.a)!), b: render(c, s, byId(s, p.b)!), cosine: +p.cos.toFixed(3), shared_entities: p.shared },
    instruction: 'Do these two nodes cover the SAME topic, such that a user would naturally expect their exchanges in one place (e.g. the same person\'s catch-up on different days, the same schedule unit, the same investigation)? Different aspects of a broader theme, or merely related topics, are NOT the same. Answer yes/no with a brief rationale.',
  }))));
  const dead = new Set<string>();
  for (const [i, p] of todo.entries()) {
    const ans = answers[i]; bump(c, 'merge_asked');
    if (!ans?.same_topic) { if (ans) remember(s, c.memo, 'merge', p.a, p.b); continue; }
    if (dead.has(p.a) || dead.has(p.b)) continue;
    const a = byId(s, p.a), b = byId(s, p.b); if (!a || !b || a.status === 'merged' || b.status === 'merged') continue;
    const size = (n: Node) => members(s, n).length;
    const [from, into] = size(a) > size(b) || (size(a) === size(b) && a.created_sequence < b.created_sequence) ? [b, a] : [a, b];
    for (const f of [...from.summary, ...into.summary]) for (const e of f.evidence) if (!c.texts.has(e.message_id)) c.texts.set(e.message_id, { exchange: e.user_message_id, text: e.quote });
    const inherited = new Set([...pairsOf(from.summary), ...pairsOf(into.summary)]);
    const ms = await optional(c, 'merge_summary', () => ask(c, {
      name: 'tree_merge_summary', schema: MergeSummary,
      data: { keep: { ...render(c, s, into, false), summary: renderFacts(into.summary) }, absorb: { ...render(c, s, from, false), summary: renderFacts(from.summary) } },
      instruction: 'Two nodes about the same topic are being merged. Return the merged title (reuse one of the two titles or the wording the user used; do not translate), up to 6 aliases (existing titles/aliases only) and a consolidated summary of at most 12 facts. Corrected/superseded facts are dropped. Each fact keeps 1-2 evidence entries copied EXACTLY from the supplied evidence (message_id + quote). Do not invent.',
      check: v => v.facts.forEach(checker(c, inherited)),
    }));
    const ops: OpInput[] = [{ op: 'merge', from: from.id, into: into.id, ...(ms ? { summary: ms.facts.map(f => lift(c, f)) } : {}) }];
    if (await commit(c, s, 'merge', ops, [from.id, into.id])) { bump(c, 'merge'); dead.add(from.id); }
  }
}

async function maybeSplit(c: Ctx, s: TreeState, nodeId: string) {
  const n = byId(s, nodeId); if (!n || n.status === 'merged' || n.owners.length < SPLIT_MIN_OWNERS) return;
  const memo = c.memo[`split:${n.id}`]; if (memo !== undefined && n.owners.length < memo + 6) return;
  const real = n.owners.filter(o => !s.noise.includes(o));
  await loadSources(c, real);
  const vecs = await exchangeVecs(c, real), usable = real.flatMap((id, i) => vecs[i] ? [{ id, v: vecs[i] }] : []);
  c.memo[`split:${n.id}`] = n.owners.length;
  const proposal = proposeSplit(usable.map(u => u.v), { minSize: 3, minSilhouette: 0.12 });
  if (!proposal) return;
  bump(c, 'split_proposed');
  const clusterOwners = proposal.clusters.map(cl => cl.flatMap(i => usable[i] ? [usable[i].id] : []));
  const shown = clusterOwners.map((owners, k) => ({ cluster: k, exchanges: owners.map(o => { const ms = c.exchange.get(o)?.messages ?? [], u = ms.find(m => m.role === 'user'), a = ms.find(m => m.role === 'assistant'); return { user_message_id: u?.message_id ?? '', user: (u?.text ?? '').slice(0, 220), assistant_message_id: a?.message_id ?? '', assistant: (a?.text ?? '').slice(0, 220) }; }) }));
  const res = await optional(c, 'split', () => ask(c, {
    name: 'tree_split_confirm', schema: SplitConfirm, data: { node: { ...render(c, s, n, false), summary: n.summary.map(f => f.text) }, silhouette: +proposal.silhouette.toFixed(3), clusters: shown },
    instruction: 'This node has grown large. The clusters were found by embedding similarity of its exchanges. Decide whether they are clearly distinct sub-topics a user would call by different names. If yes: split=true and give EVERY cluster exactly one part {cluster, title (conversation wording, no translation), kind (rule ONLY for standing user instructions about assistant behaviour; facts and legal criteria are topics), aliases (literally occurring), facts (0-3 new facts with exact quotes from the supplied cluster text)}. If the clusters are really one topic: split=false and parts=[].',
    check: v => { if (!v.split) return; if (v.parts.length !== clusterOwners.length || unique(v.parts.map(p => p.cluster)).length !== clusterOwners.length || v.parts.some(p => p.cluster >= clusterOwners.length || !p.title.trim())) throw new Error('every_cluster_needs_one_part'); const ok = checker(c, new Set()); v.parts.forEach(p => p.facts.forEach(ok)); },
  }));
  if (!res?.split) return;
  const assigned = new Map<string, number>(); clusterOwners.forEach((os, k) => os.forEach(o => assigned.set(o, k)));
  let last = 0; for (const o of n.owners) { if (assigned.has(o)) last = assigned.get(o)!; else assigned.set(o, last); }
  const factsOf = (k: number) => n.summary.filter(f => assigned.get(f.evidence[0]!.user_message_id) === k);
  const parts = res.parts.toSorted((a, b) => a.cluster - b.cluster).map(p => ({ id: crypto.randomUUID(), title: p.title.trim().slice(0, 300), kind: p.kind, aliases: p.aliases, owners: n.owners.filter(o => assigned.get(o) === p.cluster), facts: [...factsOf(p.cluster).slice(-8), ...p.facts.map(f => lift(c, f))].slice(-12) }));
  if (parts.some(p => !p.owners.length)) return;
  if (await commit(c, s, 'split', [{ op: 'split', node_id: n.id, parts }], [n.id])) { bump(c, 'split'); bump(c, 'split_children', parts.length); }
}

async function periodic(c: Ctx, s: TreeState) {
  await refreshVecs(c, s);
  const pairs = sweepPairs(s, vecOf(c)); bump(c, 'sweep_pairs', pairs.length);
  await confirmMerges(c, s, pairs, 10);
  await refreshVecs(c, s);
  const clusters = parentClusters(s, vecOf(c)).filter(cl => c.memo[`parent:${cl.toSorted().join('|')}`] === undefined).slice(0, 5);
  const answers = await Promise.all(clusters.map(cl => optional(c, 'parent', () => {
    const ns = cl.map(id => byId(s, id)!), inherited = new Set(ns.flatMap(n => pairsOf(n.summary)));
    for (const n of ns) for (const f of n.summary) for (const e of f.evidence) if (!c.texts.has(e.message_id)) c.texts.set(e.message_id, { exchange: e.user_message_id, text: e.quote });
    return ask(c, {
      name: 'tree_parent_theme', schema: ParentConfirm, data: { nodes: ns.map(n => ({ ...render(c, s, n, false), summary: renderFacts(n.summary.slice(-6)) })) },
      instruction: 'Do these sibling topic nodes share ONE broader parent theme that a user would recognise as a larger branch (e.g. a product/company and its sub-aspects)? If yes: share_parent=true, a parent title in the wording the user used (no translation; English proper nouns kept), up to 6 aliases that literally appear in the node titles/aliases, and 2-5 overview facts with evidence copied EXACTLY (message_id + quote) from the supplied evidence. If they are merely loosely related, share_parent=false with empty title, aliases, facts.',
      check: v => { if (!v.share_parent) return; if (!v.title.trim() || v.facts.length < 1) throw new Error('parent_needs_title_and_facts'); v.facts.forEach(checker(c, inherited)); },
    });
  })));
  for (const [i, cl] of clusters.entries()) {
    c.memo[`parent:${cl.toSorted().join('|')}`] = 1;
    const a = answers[i]; if (!a?.share_parent) continue;
    if (await commit(c, s, 'parent', [{ op: 'create_parent', id: crypto.randomUUID(), member_ids: cl, title: a.title.trim().slice(0, 300), kind: 'topic', aliases: a.aliases, facts: a.facts.map(f => lift(c, f)) }], cl)) bump(c, 'parent');
  }
}

async function links(c: Ctx, s: TreeState, target: string, created: boolean, entities: string[]) {
  const cand = crossLinkCandidates(s, target, entities, created, vecOf(c));
  if (!cand.length) return;
  bump(c, 'link_candidates', cand.length);
  const res = await optional(c, 'links', () => ask(c, {
    name: 'tree_link_confirm', schema: LinkConfirm,
    data: { current: render(c, s, byId(s, target)!, false), candidates: cand.map((p, index) => ({ index, link_kind: p.kind_options[0], from: render(c, s, byId(s, p.from)!, false), to: render(c, s, byId(s, p.to)!), shared_entities: p.shared })) },
    instruction: 'Confirm which candidate links are real and useful. reference = the two nodes (in different branches) genuinely refer to the same entity or concern so that a user asking about one would want the other. governs = the "from" rule node actually applies to the "to" node\'s subject. Reject coincidental entity overlap. Return one decision per candidate index.',
    check: v => { if (v.decisions.some(d => d.index >= cand.length)) throw new Error('bad_index'); },
  }));
  if (!res) return;
  const userMsg = c.exchange.get(c.user)?.messages.find(m => m.role === 'user');
  for (const d of res.decisions.filter(x => x.link)) {
    const p = cand[d.index]; if (!p) continue;
    const kind = p.kind_options[0] ?? 'reference', from = byId(s, p.from), to = byId(s, p.to);
    if (!from || !to || from.status === 'merged' || to.status === 'merged' || from.id === to.id) continue;
    const ev = kind === 'governs' && from.summary[0] ? from.summary[0].evidence.slice(0, 1) : userMsg ? [{ user_message_id: c.user, message_id: userMsg.message_id, quote: userMsg.text.trim().slice(0, 200) }] : [];
    if (!ev.length || !ev[0]?.quote) continue;
    if (await commit(c, s, 'link', [{ op: 'add_link', from: from.id, to: to.id, kind, evidence: ev, confidence: 0.8 }], [])) bump(c, `link_${kind}`);
  }
}

/** Grows the tree with one exchange. `s` is the current snapshot (mutated to the post-state). */
export async function growExchange(input: { client: TreeClient; provider: Provider; signal: AbortSignal; memo: Record<string, number>; snapshot: Snapshot; user_message_id: string; sequence: number }): Promise<GrowthLog> {
  const s = input.snapshot;
  const c: Ctx = { client: input.client, provider: input.provider, signal: input.signal, memo: input.memo, user: input.user_message_id, sequence: input.sequence, index: s.processed.length, texts: new Map(), exchange: new Map(), vec: new Map(), exVec: new Map(), ops: {}, llm: 0 };
  if (s.processed.includes(c.user)) return { node: ownerNodeOf(s, c.user)?.id ?? '', created: false, noise: false, ops: { already: 1 }, llm: 0 };
  await loadSources(c, [c.user, ...s.processed.slice(-3)]);
  const ex = c.exchange.get(c.user);
  // Retention decisions (deleted memory, deny_turn/deny_task) exclude the exchange from knowledge: nothing to grow.
  if (!ex?.allowed) return { node: '', created: false, noise: false, ops: { excluded: 1 }, llm: 0 };
  const userText = ex.messages.filter(m => m.role === 'user').map(m => m.text).join('\n');
  // Load stored node vectors once; missing/stale ones are refreshed lazily.
  for (const v of (await c.client.vectors(c.signal)).vectors) { const n = byId(s, v.id); if (n && n.embedded_sha256 === v.sha256) c.vec.set(v.id, v.vector); }
  if (isNoise(userText)) {
    const prev = s.processed.at(-1), prevNode = prev ? ownerNodeOf(s, prev) : undefined;
    const ops: OpInput[] = prevNode && prevNode.status !== 'merged'
      ? [{ op: 'attach', node_id: prevNode.id, user_message_id: c.user, noise: true }]
      : (() => { const id = crypto.randomUUID(); return [{ op: 'create_node', id, kind: 'topic', title: userText.trim().slice(0, 40) || '(빈 입력)' }, { op: 'attach', node_id: id, user_message_id: c.user, noise: true }] satisfies OpInput[]; })();
    await commit(c, s, 'noise', ops, prevNode ? [prevNode.id] : []);
    return { node: ownerNodeOf(s, c.user)?.id ?? '', created: !prevNode, noise: true, ops: { noise: 1 }, llm: 0 };
  }
  const r = await insert(c, s);
  let target = r.target;
  await refreshVecs(c, s);
  await summaries(c, s, target);
  await refreshVecs(c, s);
  const cands = mergeCandidates(s, target, vecOf(c));
  if (cands.length) { bump(c, 'merge_candidates', cands.length); await confirmMerges(c, s, cands, 3); }
  target = ownerNodeOf(s, c.user)?.id ?? target;
  await maybeSplit(c, s, target);
  target = ownerNodeOf(s, c.user)?.id ?? target;
  await links(c, s, target, r.created, r.entities);
  if ((c.index + 1) % SWEEP_EVERY === 0) await periodic(c, s);
  await refreshVecs(c, s);
  return { node: ownerNodeOf(s, c.user)?.id ?? target, created: r.created, noise: false, ops: c.ops, llm: c.llm };
}
