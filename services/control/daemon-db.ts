import { AsyncLocalStorage } from 'node:async_hooks';
import type { Principal } from './auth';
import type { Database, Transaction } from './db';
import { fenceRun, type VmLock } from './repository/daemon-session';
import { lockWorkspace } from './repository/lock-order';

type Scope={readonly principal:Principal;readonly run?:string;readonly kind:'read'|'mutation'|'poll'|'session';readonly workspaceLock?:'share'|'update';readonly vmLock?:VmLock;readonly runLock?:'share'|'update';readonly inlineRead?:boolean;readonly transaction?:Transaction};
export const daemonRequest=new AsyncLocalStorage<Scope>();
const writes=(text:string)=>/\b(INSERT|UPDATE|DELETE|MERGE|CALL)\b|\bFOR\s+(?:(?:NO\s+)?KEY\s+)?(UPDATE|SHARE)\b/i.test(text);
// Keep postgres Query objects intact for interpolation (e.g. sql`FOR UPDATE`).
// A fence executes only when a full query is awaited, not when a fragment is built.
function deferredQuery(query:unknown,execute:()=>Promise<unknown>){
  if(!query||typeof query!=='object')return query;
  return new Proxy(query,{get(target,key,receiver){
    if(key==='then')return (fulfilled?:unknown,rejected?:unknown)=>execute().then(
      value=>typeof fulfilled==='function'?Reflect.apply(fulfilled,undefined,[value]):value,
      error=>{if(typeof rejected==='function')return Reflect.apply(rejected,undefined,[error]);throw error;});
    return Reflect.get(target,key,receiver);
  }});
}
async function guard(tx:Transaction,scope:Scope,readonly=false){
  // poll owns its SKIP LOCKED workspace/VM acquisition and rechecks the session
  // there; pre-locking here would turn a busy poll into a blocking request.
  if(scope.kind==='poll'||scope.inlineRead)return;
  if(scope.kind==='read'||readonly){await fenceRun(tx,scope.principal,scope.run,false);return;}
  await lockWorkspace(tx,scope.principal.workspace_id,scope.workspaceLock??'share');
  if(scope.kind==='mutation')await fenceRun(tx,scope.principal,scope.run,scope.vmLock??'key-share',scope.runLock??'update');
}
function guardedTransaction(tx:Transaction,scope:Scope,readonly=false):Transaction{
  let ready:Promise<void>|undefined;
  const execute=(text:string,query:unknown)=>{
    // Some protected readers set their snapshot mode as the first statement in
    // their callback. Let that run before the first ownership SELECT.
    return deferredQuery(query,async()=>{
      if(/^\s*SET\s+TRANSACTION\b/i.test(text))readonly||=/read\s+only/i.test(text);
      else{ready??=guard(tx,scope,readonly);await ready;}
      return query;
    });
  };
  return new Proxy(tx,{
    get(target,key){
      if(key==='unsafe')return (...args:unknown[])=>execute(typeof args[0]==='string'?args[0]:'',Reflect.apply(target.unsafe,target,args));
      if(key==='savepoint')return (...args:unknown[])=>{ready??=guard(tx,scope,readonly);return ready.then(()=>Reflect.apply(target.savepoint,target,args));};
      return Reflect.get(target,key,target);
    },
    apply(target,self,args){
      if(!Array.isArray(args[0])||!('raw' in args[0]))return Reflect.apply(target,self,args);
      return execute(args[0].join(' '),Reflect.apply(target,self,args));
    },
  });
}
// Inject fencing at the control boundary, not in protected knowledge APIs.
// Their BEGIN callbacks receive the same guarded transaction, not a second one.
export function daemonDatabase(sql:Database):Database{
  return new Proxy(sql,{
    get(target,key){
      if(key==='begin')return (first:unknown,second?:unknown)=>{
        const scope=daemonRequest.getStore(),callback=typeof first==='function'?first:second;
        if(typeof callback!=='function')throw new TypeError('Expected transaction callback');
        const work=async(tx:Transaction)=>{
          const protectedTx=scope&&!scope.transaction?guardedTransaction(tx,scope,typeof first==='string'&&/read\s+only/i.test(first)):tx;
          const invoke=()=>{const result:unknown=Reflect.apply(callback,undefined,[protectedTx]);return result;};
          return scope?daemonRequest.run({...scope,transaction:protectedTx},invoke):invoke();
        };
        if(scope?.transaction)return scope.transaction.savepoint(work);
        return typeof first==='string'?target.begin(first,work):scope?.kind==='read'?target.begin('isolation level repeatable read read only',work):target.begin(work);
      };
      if(key==='unsafe')return (...args:unknown[])=>{
        const scope=daemonRequest.getStore();
        if(scope?.transaction)return Reflect.apply(scope.transaction.unsafe,scope.transaction,args);
        if(scope&&typeof args[0]==='string'&&writes(args[0]))return deferredQuery(Reflect.apply(target.unsafe,target,args),()=>target.begin(async tx=>{await guard(tx,scope);const result:unknown=Reflect.apply(tx.unsafe,tx,args);return result;}));
        return Reflect.apply(target.unsafe,target,args);
      };
      return Reflect.get(target,key,target);
    },
    apply(target,self,args){
      const scope=daemonRequest.getStore(),text=Array.isArray(args[0])&&'raw' in args[0]?args[0].join(' '):'';
      if(scope?.transaction)return Reflect.apply(scope.transaction,scope.transaction,args);
      if(scope&&(writes(text)||(scope.run||scope.kind==='read')&&/^\s*(SELECT|WITH)\b/i.test(text)))return deferredQuery(Reflect.apply(target,self,args),()=>{
        // A standalone SELECT cannot mutate, so it only needs the non-locking
        // read fence; mutation-route locks here would serialize the workspace.
        const readOnly=scope.kind==='read'||!writes(text);
        const work=async(tx:Transaction)=>{await guard(tx,scope,readOnly);const result:unknown=Reflect.apply(tx,tx,args);return result;};
        return readOnly?target.begin('read only',work):target.begin(work);
      });
      return Reflect.apply(target,self,args);
    },
  });
}
