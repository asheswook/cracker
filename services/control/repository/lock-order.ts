import { DomainError } from '../../../packages/protocol';
import type { Query } from '../db';

// Existing-row order: workspace → VM → run → conversation/task → child rows.
// Call before any VM lock; callers that later need UPDATE must take it up front.
export async function lockWorkspace(sql:Query,workspace:string,mode:'share'|'update'='share',skip=false):Promise<boolean>{
  const rows=mode==='update'
    ? await sql`SELECT id FROM assistant.workspaces WHERE id=${workspace} FOR UPDATE`
    : skip?await sql`SELECT id FROM assistant.workspaces WHERE id=${workspace} FOR KEY SHARE SKIP LOCKED`
      :await sql`SELECT id FROM assistant.workspaces WHERE id=${workspace} FOR KEY SHARE`;
  if(!rows.length&&!skip)throw new DomainError('not_found','Workspace not found',404);
  return rows.length>0;
}
