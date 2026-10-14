import { authenticate, requireOrigin } from './auth';
import type { Database, Query } from './db';
import { DomainError } from '../../packages/protocol';
import { z } from 'zod';

export async function currentScreenSession(sql:Query,workspace:string,vm:string,session:string|null):Promise<boolean>{
  if('begin' in sql)return sql.begin(tx=>currentScreenSession(tx,workspace,vm,session));
  const row=z.object({daemon_session_id:z.uuid().nullable()}).optional().parse((await sql`SELECT daemon_session_id FROM assistant.vms WHERE id=${vm} AND workspace_id=${workspace}`)[0]);
  return !!row&&(row.daemon_session_id===null||row.daemon_session_id===session);
}

export async function screenUpgrade(sql:Database,request:Request,vm:string,forward:(key:string,request:Request)=>Promise<Response>){
  const authorization=request.headers.get('Authorization');
  if(!authorization)requireOrigin(request);
  const principal=await sql.begin(tx=>authenticate(tx,authorization??undefined,request.headers.get('Cookie')??undefined));
  const rows=await sql.begin(tx=>tx`SELECT id,daemon_session_id FROM assistant.vms WHERE id=${vm} AND workspace_id=${principal.workspace_id}`);
  if(!rows.length||principal.role==='vm'&&principal.vm_id!==vm)throw new DomainError('not_found','VM not found',404);
  let verifiedSession:string|null=null;
  if(principal.role==='vm'){
    const current=z.object({daemon_session_id:z.uuid().nullable()}).parse(rows[0]).daemon_session_id;
    const session=z.uuid().optional().safeParse(request.headers.get('x-daemon-session')??undefined);
    if(!session.success||current&&session.data!==current)throw new DomainError('stale_session','Daemon screen session was fenced',409);
    verifiedSession=current;
  }
  const headers=new Headers(request.headers);
  headers.delete('Authorization');headers.delete('Cookie');
  headers.delete('X-Screen-Daemon-Session');
  if(verifiedSession)headers.set('X-Screen-Daemon-Session',verifiedSession);
  headers.set('X-Screen-Role',principal.role);headers.set('X-Screen-Workspace',principal.workspace_id);headers.set('X-Screen-VM',vm);
  if(!principal.credential_hash)throw new DomainError('unauthorized','Credential identity missing',401);
  headers.set('X-Screen-Token-Hash',principal.credential_hash);headers.delete('X-Screen-Session-Hash');
  if(principal.session_hash)headers.set('X-Screen-Session-Hash',principal.session_hash);
  return forward(`${principal.workspace_id}:${vm}`,new Request(request,{headers}));
}
