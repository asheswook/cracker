import { z } from 'zod';
import { createDatabase } from '../services/control/db';
import { enqueueBackfill } from '../packages/knowledge-tree/store';

if (process.argv.includes('--help')) {
  console.log('DATABASE_URL=postgres://... bun scripts/knowledge-tree-backfill.ts [--workspace <uuid>]\nEnqueues every real (non-synthetic) user message per workspace, ordered by sequence. Idempotent.');
  process.exit(0);
}
const url = z.string().url().parse(process.env['DATABASE_URL']);
const flag = process.argv.indexOf('--workspace');
const only = flag >= 0 ? z.uuid().parse(process.argv[flag + 1]) : null;
const sql = createDatabase(url);
try {
  const workspaces = z.array(z.object({ id: z.uuid() })).parse(
    only ? await sql`SELECT id FROM assistant.workspaces WHERE id=${only}` : await sql`SELECT id FROM assistant.workspaces ORDER BY id`,
  );
  let total = 0;
  for (const { id } of workspaces) {
    const inserted = await enqueueBackfill(sql, id);
    total += inserted;
    console.log(JSON.stringify({ workspace: id, enqueued: inserted }));
  }
  console.log(JSON.stringify({ workspaces: workspaces.length, enqueued: total }));
} finally {
  await sql.end();
}
