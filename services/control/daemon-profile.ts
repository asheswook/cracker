import type { VmLock } from './repository/daemon-session';
import { eventVmLock } from './repository/event-lock';

// Lock modes are chosen before the callback takes any lower-order lock. Do not
// upgrade SHARE to UPDATE after acquiring run/task locks.
export function daemonProfile(method:string,path:string,body:unknown,view?:string){
  const session=path==='/v1/daemon/session',poll=path==='/v1/daemon/poll';
  const protectedRead=/\/context\/[^/]+\/(claims\/read|structure\/(read|corpus)|tree\/(snapshot|search|sources|clef|vectors|embed-texts|queue\/status))$/.test(path)||/^\/v1\/daemon\/knowledge-tree\/(snapshot|search|sources|clef|vectors|embed-texts|queue\/status)$/.test(path);
  // Audited GET exceptions: responsibility dispatch writes rows; the local login
  // callback owns/locks its VM before reading bound ciphertext. HEAD uses the
  // same handler/profile where the router supports it.
  const lockingGet=/^\/v1\/daemon\/(responsibilities|model-account\/callback)\/?$/.test(path);
  const read=(method==='GET'||method==='HEAD'||protectedRead||path.endsWith('/prior-work'))&&!lockingGet;
  const kind=session?'session':poll?'poll':read?'read':'mutation';
  const workspaceUpdate=!read&&/\/(schedules|responsibilities|memory|proactive-work|extensions|artifact-index)(\/|$)|\/conversations\/[^/]+\/artifacts$|\/context\/[^/]+\/(semantic|claims|structure)(\/|$)/.test(path);
  let vmLock:VmLock=workspaceUpdate?'share':'key-share';
  if(/\/(accept|resume)\//.test(path)||path.endsWith('/computer-control')||/\/(schedules|extensions|model-settings|model-account|subscription)(\/|$)/.test(path))vmLock='update';
  if(path.endsWith('/composing'))vmLock='no-key-update';
  if(path.endsWith('/events')&&body!==null&&typeof body==='object'&&'kind' in body)vmLock=eventVmLock(body.kind);
  // Knowledge tree writes are workspace-wide background work serialized by their own advisory locks; the run is only an
  // ownership credential, so it is fenced with SHARE instead of FOR UPDATE (avoids contention with live run requests).
  const treeWrite=!read&&(/\/context\/[^/]+\/tree\//.test(path)||path.startsWith('/v1/daemon/knowledge-tree/'));
  return {kind,workspaceLock:workspaceUpdate?'update':'share',vmLock,runLock:treeWrite?'share':'update',inlineRead:read&&/^\/v1\/daemon\/context\/[^/]+$/.test(path)&&view==='work_mailbox'} as const;
}
