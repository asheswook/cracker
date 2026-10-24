/**
 * One-off maintenance of an existing workspace knowledge tree (operator script).
 *   bun scripts/knowledge-tree-maintain.ts forget --workspace <uuid> --pattern '<postgres regex on user message content>' [--apply]
 *   bun scripts/knowledge-tree-maintain.ts review --workspace <uuid> [--apply]
 * forget: removes matching user exchanges from the tree (same operation as memory deletion), queue rows marked done.
 * review: asks the workspace's model, per node, whether rule nodes are real standing instructions and whether top-level
 *   nodes with children mix unrelated subjects; applies set_kind / set_parent ops through the normal apply path.
 * Without --apply only the plan is printed.
 */
import { z } from 'zod';
import { createDatabase } from '../services/control/db';
import { children, live, members, type TreeState } from '../packages/knowledge-tree/core';
import * as store from '../packages/knowledge-tree/store';
import type { OpInput } from '../packages/knowledge-tree/schema';

const args = process.argv.slice(2), cmd = args[0];
const flag = (name: string) => { const i = args.indexOf(name); return i >= 0 ? args[i + 1] : undefined; };
const workspace = z.uuid().parse(flag('--workspace')), apply = args.includes('--apply');
const sql = createDatabase(z.string().url().parse(process.env['DATABASE_URL']));

async function anchor(s: TreeState) {
  const last = s.processed.at(-1);
  if (!last) throw new Error('empty tree');
  return last;
}
try {
  if (cmd === 'forget') {
    const pattern = z.string().min(1).parse(flag('--pattern'));
    const rows = z.array(z.object({ id: z.uuid(), content: z.string() })).parse(await sql`SELECT id,content FROM assistant.messages WHERE workspace_id=${workspace} AND role='user' AND content ~ ${pattern} ORDER BY sequence`);
    console.log(JSON.stringify({ matched: rows.length, sample: rows.slice(0, 5).map(r => r.content.slice(0, 60)) }));
    if (apply) console.log(JSON.stringify(await store.forget(sql, workspace, rows.map(r => r.id))));
  } else if (cmd === 'review') {
    const plan = z.array(z.object({ ops: z.array(z.unknown()), why: z.string() })).parse(JSON.parse(await Bun.stdin.text()));
    const s = await sql.begin(tx => store.readSnapshot(tx, workspace));
    const at = await anchor(s);
    for (const step of plan) {
      const ops = step.ops as OpInput[];
      const ids = ops.flatMap(o => 'node_id' in o ? [o.node_id] : []);
      const fresh = await sql.begin(tx => store.readSnapshot(tx, workspace));
      const expected = Object.fromEntries(ids.flatMap(id => { const n = fresh.nodes.find(x => x.id === id); return n ? [[id, n.revision] as const] : []; }));
      console.log(JSON.stringify({ why: step.why, ops }));
      if (apply) await store.applyOps(sql, workspace, { user_message_id: at, ops: ops.map(o => o as never), expected });
    }
  } else if (cmd === 'show') {
    const s = await sql.begin(tx => store.readSnapshot(tx, workspace));
    const tops = live(s).filter(n => n.parent_id === null);
    const dump = (id: string, d: number): unknown => { const n = s.nodes.find(x => x.id === id)!; return { id: n.id, kind: n.kind, title: n.title, own: n.owners.length, size: members(s, n).length, summary: n.summary.slice(0, 3).map(f => f.text.slice(0, 120)), children: children(s, n.id).map(c => dump(c.id, d + 1)) }; };
    console.log(JSON.stringify({ rules: live(s).filter(n => n.kind === 'rule').map(n => ({ id: n.id, title: n.title, parent: n.parent_id, summary: n.summary.slice(0, 2).map(f => f.text.slice(0, 140)) })), mixed: tops.filter(n => children(s, n.id).length).map(n => dump(n.id, 0)) }, null, 1));
  } else throw new Error('usage: forget | review | show');
} finally { await sql.end(); }
