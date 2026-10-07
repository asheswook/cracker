import { expect, test } from 'bun:test';
import { PanelTransition } from '../../src/panel-transition';
import type { ReaderSnapshotValue } from '../../src/native-reader-protocol';
const tick=()=>new Promise(resolve=>setTimeout(resolve,0));
function deferred(){let resolve:(value:unknown)=>void=()=>{throw new Error('uninitialized')};const promise=new Promise<unknown>(done=>{resolve=done});return {promise,resolve};}
const proof=(revision:number):ReaderSnapshotValue=>({v:1,document:crypto.randomUUID(),scope:'scope',navigation:1,revision,sequence:1,interaction:0,geometry:3,mode:'reading',offset:400,contentHeight:3000,width:402,height:666,headerHeight:120,keyboardMoving:false,suspended:false,dragging:false});
test('native cover acknowledgement precedes any panel mutation',async()=>{const begin=deferred(),events:string[]=[];const t=new PanelTransition(async()=>{events.push('begin');return begin.promise;});const p=t.request('panel',()=>events.push('mutate'));expect(events).toEqual(['begin']);begin.resolve({ok:true,stage:'covered'});await p;expect(events).toEqual(['begin','mutate']);});
test('older host rejection preserves functional mutation exactly once',async()=>{let changes=0;const t=new PanelTransition(async()=>{throw new Error('unknown_method');});await t.request('panel',()=>changes++);t.complete('panel');await tick();expect(changes).toBe(1);});
test('new intent wins over late begin acknowledgement without replay',async()=>{const first=deferred(),events:string[]=[];let call=0;const t=new PanelTransition(async()=>++call===1?first.promise:{ok:true,stage:'covered'});const p=t.request('panel',()=>events.push('old'));await t.request('chat',()=>events.push('new'));first.resolve({ok:true,stage:'covered'});await p;expect(events).toEqual(['new']);});
test('close does not finish before grounded reader proof; duplicate finish deduplicates',async()=>{const calls:Readonly<Record<string,unknown>>[]=[];const finish=deferred();const t=new PanelTransition(async p=>{calls.push(p);return p.kind==='finish'?finish.promise:{ok:true,stage:'covered'};});await t.request('chat',()=>{});t.complete('panel');t.complete('chat');expect(calls).toHaveLength(1);const p=proof(4);t.complete('chat',p);t.complete('chat',p);expect(calls).toHaveLength(2);expect(calls[1]?.reader).toEqual(p);finish.resolve({ok:true,stage:'covered'});await tick();t.complete('chat',p);expect(calls).toHaveLength(2);});
test('geometry rejection retries only a newer proof, never stale snapshot',async()=>{const calls:Readonly<Record<string,unknown>>[]=[];const finish=deferred();const t=new PanelTransition(async p=>{calls.push(p);return p.kind==='finish'&&calls.length===2?finish.promise:{ok:true,stage:'covered'};});await t.request('chat',()=>{});t.complete('chat',proof(4));const latest=proof(5);t.complete('chat',latest);finish.resolve({ok:false,error:'geometry_changed'});await tick();expect(calls).toHaveLength(3);expect(calls[2]?.reader).toEqual(latest);});
test('document/scope cancellation invalidates delayed mutations and completion',async()=>{const begin=deferred();let changes=0;const calls:Readonly<Record<string,unknown>>[]=[];const t=new PanelTransition(async p=>{calls.push(p);return p.kind==='begin'?begin.promise:{ok:true,stage:'covered'};});const pending=t.request('panel',()=>changes++);t.cancel();begin.resolve({ok:true,stage:'covered'});await pending;t.complete('panel');expect(changes).toBe(0);expect(calls.map(x=>x.kind)).toEqual(['begin','cancel']);});
test('web animation bypass is false until native accepts and is target-specific',async()=>{const begin=deferred();const t=new PanelTransition(async()=>begin.promise);const pending=t.request('panel',()=>{expect(t.hasAcceptedCover('panel')).toBe(true);});expect(t.hasAcceptedCover('panel')).toBe(false);begin.resolve({ok:true,stage:'covered'});await pending;expect(t.hasAcceptedCover('panel')).toBe(true);expect(t.hasAcceptedCover('chat')).toBe(false);t.cancel();expect(t.hasAcceptedCover('panel')).toBe(false);});
test('rejected native cover never bypasses web motion',async()=>{const t=new PanelTransition(async()=>({ok:false}));await t.request('panel',()=>expect(t.hasAcceptedCover('panel')).toBe(false));expect(t.hasAcceptedCover('panel')).toBe(false);});
test('completion clears accepted cover',async()=>{const t=new PanelTransition(async()=>({ok:true,stage:'covered'}));await t.request('panel',()=>{});t.complete('panel');await tick();expect(t.hasAcceptedCover('panel')).toBe(false);});
test('live source remains unchanged until keyboard/source agreement is covered',async()=>{let changes=0,readyRequests=0;const calls:Readonly<Record<string,unknown>>[]=[];const source=deferred();const t=new PanelTransition(async p=>{calls.push(p);return p.kind==='begin'?{ok:true,stage:'waiting'}:source.promise;},()=>readyRequests++);const pending=t.request('panel',()=>changes++);await tick();expect(readyRequests).toBe(1);expect(changes).toBe(0);expect(t.hasAcceptedCover('panel')).toBe(false);t.sourceReady(proof(4));expect(calls.map(p=>p.kind)).toEqual(['begin','source']);source.resolve({ok:true,stage:'covered'});await pending;expect(changes).toBe(1);expect(t.hasAcceptedCover('panel')).toBe(true);t.cancel();});
test('keyboard-pending source proof cannot claim cover; fresh proof can retry',async()=>{let sources=0,changes=0;const t=new PanelTransition(async p=>p.kind==='begin'?{ok:true,stage:'waiting'}:p.kind==='source'&&++sources===1?{ok:false,error:'reader_pending'}:{ok:true,stage:'covered'});const pending=t.request('panel',()=>changes++);await tick();t.sourceReady(proof(3));await tick();expect(changes).toBe(0);expect(t.hasAcceptedCover('panel')).toBe(false);t.sourceReady(proof(4));await pending;expect(changes).toBe(1);t.cancel();});
test('native background cancellation during source wait never mutates stale panel',async()=>{let changes=0;const t=new PanelTransition(async()=>({ok:true,stage:'waiting'}));const pending=t.request('panel',()=>changes++);await tick();t.invalidate(t.document,1);await pending;expect(changes).toBe(0);expect(t.hasAcceptedCover('panel')).toBe(false);});

test('menu target uses v4 and holds mutation until grounded source acknowledgement',async()=>{
  const calls:Readonly<Record<string,unknown>>[]=[];let changes=0;const source=deferred();
  const transition=new PanelTransition(async packet=>{calls.push(packet);return packet.kind==='begin'?{ok:true,stage:'waiting'}:packet.kind==='source'?source.promise:{ok:true};});
  const pending=transition.request('menu',()=>changes++);await tick();
  expect(changes).toBe(0);expect(calls[0]?.version).toBe(4);
  transition.sourceReady(proof(9));expect(calls[1]?.version).toBe(4);expect(changes).toBe(0);
  source.resolve({ok:true,stage:'covered'});await pending;expect(changes).toBe(1);
  expect(transition.hasAcceptedCover('menu')).toBe(true);transition.complete('menu');await tick();
  expect(calls[2]?.kind).toBe('finish');expect(calls[2]?.version).toBe(4);expect(transition.hasAcceptedCover('menu')).toBe(false);
});
test('menu rejection preserves exactly one functional fallback without cover bypass',async()=>{
  let changes=0;const transition=new PanelTransition(async()=>({ok:false,error:'invalid'}));
  await transition.request('menu',()=>changes++);expect(changes).toBe(1);expect(transition.hasAcceptedCover('menu')).toBe(false);
});
test('menu cancellation and reopen discard stale source acknowledgement',async()=>{
  const stale=deferred();let changes=0;let begins=0;
  const transition=new PanelTransition(async packet=>packet.kind==='begin'&&++begins===1?stale.promise:{ok:true,stage:'covered'});
  const old=transition.request('menu',()=>changes+=100);transition.cancel();
  await transition.request('menu',()=>changes++);stale.resolve({ok:true,stage:'covered'});await old;
  expect(changes).toBe(1);transition.cancel();
});
test('accepted menu cleanup cancels its still-owned transition on teardown',async()=>{
  const calls:Readonly<Record<string,unknown>>[]=[];
  const transition=new PanelTransition(async packet=>{calls.push(packet);return {ok:true,stage:'covered'};});
  await transition.request('menu',()=>{});
  const cleanup=transition.acceptedCoverCleanup('menu');
  expect(cleanup).toBeDefined();
  cleanup?.();
  expect(transition.hasAcceptedCover('menu')).toBe(false);
  expect(calls.map(packet=>packet.kind)).toEqual(['begin','cancel']);
});
test('old accepted menu cleanup cannot cancel a later accepted menu transaction',async()=>{
  const calls:Readonly<Record<string,unknown>>[]=[];
  const transition=new PanelTransition(async packet=>{calls.push(packet);return {ok:true,stage:'covered'};});
  await transition.request('menu',()=>{});
  const cleanup=transition.acceptedCoverCleanup('menu');
  await transition.request('menu',()=>{});
  cleanup?.();
  expect(transition.hasAcceptedCover('menu')).toBe(true);
  expect(calls.map(packet=>packet.kind)).toEqual(['begin','begin']);
  transition.cancel();
});
test('cleanup of completed menu cannot cancel a later pending source acknowledgement',async()=>{
  const source=deferred();let changes=0;
  const transition=new PanelTransition(async packet=>packet.kind==='source'?source.promise:{ok:true,stage:packet.kind==='begin'&&packet.generation!==1?'waiting':'covered'});
  await transition.request('menu',()=>{});
  const cleanup=transition.acceptedCoverCleanup('menu');
  transition.complete('menu');await tick();
  const next=transition.request('menu',()=>changes++);await tick();
  transition.sourceReady(proof(4));
  cleanup?.();
  source.resolve({ok:true,stage:'covered'});await next;
  expect(changes).toBe(1);
  expect(transition.hasAcceptedCover('menu')).toBe(true);
  transition.cancel();
});
test('unaccepted and differently targeted covers do not grant menu cleanup ownership',async()=>{
  const transition=new PanelTransition(async()=>({ok:true,stage:'covered'}));
  expect(transition.acceptedCoverCleanup('menu')).toBeUndefined();
  await transition.request('panel',()=>{});
  expect(transition.acceptedCoverCleanup('menu')).toBeUndefined();
  transition.cancel();
});
