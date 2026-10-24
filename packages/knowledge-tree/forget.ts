/**
 * Removing exchanges from the knowledge tree (pure). Used when a source leaves knowledge: memory deletion/suppression,
 * operator cleanup. The exchange's membership, every summary fact and link that cites it, and nodes left without
 * members or facts are removed; a parent left empty becomes removable only if it has no live children.
 */
import { byId, clone, live, recomputeDepth, unique, validateState, type TreeState } from './core.ts';

export type Forgotten = { state: TreeState; touched: string[]; removed: string[] };
export function forgetExchanges(state: TreeState, ids: readonly string[]): Forgotten {
  const gone = new Set(ids), s = clone(state), touched = new Set<string>(), removed: string[] = [];
  const cites = (e: { user_message_id: string }) => gone.has(e.user_message_id);
  for (const n of s.nodes) {
    const owners = n.owners.filter(o => !gone.has(o)), mentions = n.mentions.filter(o => !gone.has(o));
    const summary = n.summary.flatMap(f => { const evidence = f.evidence.filter(e => !cites(e)); return evidence.length ? [{ ...f, evidence }] : []; });
    if (owners.length !== n.owners.length || mentions.length !== n.mentions.length || summary.length !== n.summary.length || summary.some((f, i) => f.evidence.length !== n.summary[i]?.evidence.length)) {
      n.owners = owners; n.mentions = mentions; n.summary = summary; n.revision++; touched.add(n.id);
    }
  }
  s.links = s.links.flatMap(l => { const evidence = l.evidence.filter(e => !cites(e)); return evidence.length ? [{ ...l, evidence }] : []; });
  s.processed = s.processed.filter(id => !gone.has(id));
  s.noise = s.noise.filter(id => !gone.has(id));
  for (const id of gone) { delete s.sequence[id]; delete s.entities[id]; }
  // Remove nodes that now hold nothing (no members, no facts, no live children), bottom-up.
  for (let changed = true; changed;) {
    changed = false;
    for (const n of live(s)) {
      const children = live(s).some(c => c.parent_id === n.id);
      if (!n.owners.length && !n.mentions.length && !n.summary.length && !children) {
        // Drop the node and every merged tombstone whose chain ends at it.
        const dead = new Set([n.id]);
        for (let grew = true; grew;) { grew = false; for (const x of s.nodes) if (x.status === 'merged' && x.merged_into && dead.has(x.merged_into) && !dead.has(x.id)) { dead.add(x.id); grew = true; } }
        s.nodes = s.nodes.filter(x => !dead.has(x.id));
        for (const id of dead) if (id !== n.id) removed.push(id);
        s.links = s.links.filter(l => !dead.has(l.from) && !dead.has(l.to));
        removed.push(n.id); touched.delete(n.id);
        if (n.parent_id && byId(s, n.parent_id)) touched.add(n.parent_id);
        changed = true;
      }
    }
  }
  // A parent whose children were removed and that has a single remaining child stays; depth is recomputed.
  recomputeDepth(s);
  validateState(s);
  return { state: s, touched: unique([...touched]).filter(id => byId(s, id)), removed };
}
