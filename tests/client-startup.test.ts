import { afterEach, expect, mock, test } from 'bun:test';
import { Id } from '../apps/web/src/types';
import { defaultAppearance } from '../packages/appearance/schema';

const workspace=Id.parse(crypto.randomUUID()), conversation=Id.parse(crypto.randomUUID());
const appearanceRevision=crypto.randomUUID();
const storage=new Map<string,string>();
const original=Object.getOwnPropertyDescriptor(globalThis,'localStorage');
Object.defineProperty(globalThis,'localStorage',{configurable:true,value:{getItem:(key:string)=>storage.get(key)??null,setItem:(key:string,value:string)=>{storage.set(key,value);},removeItem:(key:string)=>{storage.delete(key);}}});
let blocked: Promise<unknown> | undefined;
let slowStarted=Promise.withResolvers<void>();
const message={id:crypto.randomUUID(),conversation_id:conversation,role:'assistant',content:'Previously received message',sequence:1,created_at:'2026-10-06T00:00:00Z',client_message_id:null};
const api=()=>({
 read:async(path:string,schema:{parse:(value:unknown)=>unknown})=>{
  if(path==='/v1/memory'&&blocked){slowStarted.resolve();return schema.parse(await blocked);}
  const bodies:Record<string,unknown>={'/v1/session':{workspace_id:workspace},'/v1/conversations':{conversations:[{id:conversation,title:'Assistant',created_at:'2026-10-06T00:00:00Z'}]},'/v1/tasks':{tasks:[]},'/v1/vms':{vms:[]},'/v1/schedules':{schedules:[]},'/v1/memory':{memories:[]},'/v1/settings':{persona:{name:'Cached name',role:'',style:''}},'/v1/appearance':{appearance:defaultAppearance,revision:appearanceRevision}};
  return schema.parse(path.includes('/messages?')?{messages:[message],cursor:1}:bodies[path]);
 },
 http:{post:()=>({json:async()=>({conversation:{id:conversation,title:'Assistant',created_at:'2026-10-06T00:00:00Z'}})}),delete:async()=>new Response(null,{status:204})},errorMessage:()=> 'fixture failure',
});
mock.module('../apps/web/src/api.ts',api);
if(process.env['STARTUP_BASELINE'])mock.module('../.local/return-screen-1006/release/source/apps/web/src/api.ts',api);
const {ClientStore}: typeof import('../apps/web/src/store')=await import(process.env['STARTUP_BASELINE'] ? '../.local/return-screen-1006/release/source/apps/web/src/store.ts' : '../apps/web/src/store');
const stores:InstanceType<typeof ClientStore>[]=[];
afterEach(async()=>{blocked=undefined;for(const store of stores.splice(0))await store.logout();storage.clear();slowStarted=Promise.withResolvers<void>();});

test('identity and conversation render before an unrelated slow memory response',async()=>{
 // Given an authenticated cold start and a memory request that remains pending.
 const pending=Promise.withResolvers<unknown>();blocked=pending.promise;
 const store=new ClientStore();stores.push(store);const starting=store.init();
 await slowStarted.promise;
 // When all independently resolved reads have had a microtask checkpoint.
 await new Promise<void>(resolve=>setTimeout(resolve,0));
 const visible={name:store.snapshot().persona.name,messages:store.snapshot().messages.length};
 pending.resolve({memories:[]});await starting;
 // Then conversation content is not gated by that unrelated endpoint.
 expect(visible).toEqual({name:'Cached name',messages:1});
});

test('a newly opened client restores authenticated cached content while refresh is pending',async()=>{
 // Given one complete previous load on the same device.
 const prior=new ClientStore();stores.push(prior);await prior.init();
 expect(prior.snapshot().connected).toBe(true);
 await new Promise<void>(resolve=>setTimeout(resolve,300));
 const pending=Promise.withResolvers<unknown>();blocked=pending.promise;
 // When a second client opens and the server resource refresh has not completed.
 const current=new ClientStore();stores.push(current);const starting=current.init();await slowStarted.promise;
 const visible={name:current.snapshot().persona.name,messages:current.snapshot().messages.length,connected:current.snapshot().connected};
 pending.resolve({memories:[]});await starting;
 // Then cached content is shown without inventing a live connection.
 expect(visible).toEqual({name:'Cached name',messages:1,connected:false});
});

process.on('beforeExit',()=>{if(original)Object.defineProperty(globalThis,'localStorage',original);else Reflect.deleteProperty(globalThis,'localStorage');});
