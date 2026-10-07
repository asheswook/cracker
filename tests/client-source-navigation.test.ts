import { test, expect, mock } from 'bun:test';
import { Id, Message } from '../apps/web/src/types.ts';
import { hasNewTailMessages } from '../apps/web/src/messageArrivals';

let reply: (path:string)=>Promise<unknown> = async()=>({});
mock.module('../apps/web/src/api.ts',()=>({
  read: async(path:string,schema:{parse:(value:unknown)=>unknown})=>schema.parse(await reply(path)),
  http:{delete:async()=>new Response(null,{status:204})},
  errorMessage:()=> 'fixture request failed',
}));
const {ClientStore}=await import('../apps/web/src/store.ts');
function message(conversation:Id,sequence:number){return Message.parse({id:crypto.randomUUID(),conversation_id:conversation,role:'user',content:`source ${sequence}`,sequence,created_at:new Date().toISOString(),client_message_id:null,read_at:null});}
function arrivalSnapshot(store: InstanceType<typeof ClientStore>) {
  return { ...store.snapshot(), pending: store.snapshot().outbox };
}

test('cached source beyond the completed sync does not announce a new message', async () => {
  // Given an already hydrated conversation.
  const store = new ClientStore(), conversation = Id.parse(crypto.randomUUID());
  const first = message(conversation, 1), source = message(conversation, 3);
  reply = async path => path.startsWith('/v1/sources/')
    ? { message: source, conversation_id: conversation }
    : { messages: [first], cursor: 1, receipts: [] };
  await store.select(conversation);
  const before = arrivalSnapshot(store);
  // When the same conversation opens an explicit source above the cached tail.
  await store.select(conversation, source.id);
  // Then source-only cache fill remains quiet.
  expect(store.snapshot().messages.map(item => item.sequence)).toEqual([1, 3]);
  expect(hasNewTailMessages(before, arrivalSnapshot(store))).toBe(false);
});

for (const sourceFirst of [true, false]) {
  test(`concurrent source and sync preserve unseen lower tail when source completes ${sourceFirst ? 'first' : 'last'}`, async () => {
    // Given a completed cursor and independent in-flight source/sync reads.
    const store = new ClientStore(), conversation = Id.parse(crypto.randomUUID());
    const first = message(conversation, 1), live = message(conversation, 2), source = message(conversation, 3);
    reply = async () => ({ messages: [first], cursor: 1, receipts: [] });
    await store.select(conversation);
    const before = arrivalSnapshot(store);
    const sourceResponse = Promise.withResolvers<unknown>(), syncResponse = Promise.withResolvers<unknown>();
    reply = async path => path.startsWith('/v1/sources/') ? sourceResponse.promise : syncResponse.promise;
    const opening = store.select(conversation, source.id), syncing = store.select(conversation);
    const completeSource = async () => { sourceResponse.resolve({ message: source, conversation_id: conversation }); await opening; };
    const completeSync = async () => { syncResponse.resolve({ messages: [live], cursor: 2, receipts: [] }); await syncing; };
    // When both complete in either order, including a consumer observing only the batch.
    await (sourceFirst ? completeSource() : completeSync());
    const between = arrivalSnapshot(store);
    await (sourceFirst ? completeSync() : completeSource());
    const after = arrivalSnapshot(store);
    // Then only synchronization introduces an arrival; batching cannot hide it.
    expect(hasNewTailMessages(before, between)).toBe(!sourceFirst);
    expect(hasNewTailMessages(between, after)).toBe(sourceFirst);
    expect(hasNewTailMessages(before, after)).toBe(true);
  });
}

test('sync catching up to an already displayed source does not announce it again', async () => {
  // Given a synchronized first message followed by an explicitly opened source.
  const store = new ClientStore(), conversation = Id.parse(crypto.randomUUID());
  const first = message(conversation, 1), source = message(conversation, 3);
  reply = async path => path.startsWith('/v1/sources/')
    ? { message: source, conversation_id: conversation }
    : { messages: [first], cursor: 1, receipts: [] };
  await store.select(conversation); await store.select(conversation, source.id);
  const before = arrivalSnapshot(store);
  reply = async () => ({ messages: [source], cursor: 3, receipts: [] });
  // When sync advances through the same source identity.
  await store.select(conversation);
  // Then the previously displayed source is deduplicated.
  expect(hasNewTailMessages(before, arrivalSnapshot(store))).toBe(false);
});

test('direct source merge preserves unconsumed page cursor and sequence ordering',async()=>{
  // Given a target beyond the first normal page.
  const store=new ClientStore(),conversation=Id.parse(crypto.randomUUID()),far=message(conversation,200),first=message(conversation,1),calls:string[]=[];
  reply=async path=>{calls.push(path);return path.startsWith('/v1/sources/')?{message:far,conversation_id:conversation}:{messages:[first],cursor:1,receipts:[]};};
  // When a target is opened and ordinary history synchronization continues.
  await store.select(conversation,far.id);
  expect(store.snapshot().syncedCursor).toBe(null);
  await store.select(conversation);
  expect(store.snapshot().syncedCursor).toBe(1);
  await store.select(conversation);
  // Then the target did not skip unseen pages and does not duplicate as pages merge.
  expect(calls[1]).toContain('after=0');expect(calls[2]).toContain('after=1');
  expect(store.snapshot().messages.map(item=>item.sequence)).toEqual([1,200]);
});

test('history hydration readiness follows selected conversation and completed sync, not source lookup',async()=>{
  const store=new ClientStore(),first=Id.parse(crypto.randomUUID()),second=Id.parse(crypto.randomUUID());
  const source=message(second,5),pending=Promise.withResolvers<unknown>();
  reply=async path=>path.startsWith('/v1/sources/')?{message:source,conversation_id:second}:path.includes(second)?pending.promise:{messages:[],cursor:0,receipts:[]};
  await store.select(first);
  expect(store.snapshot().syncedCursor).toBe(0);
  await store.select(second,source.id);
  expect(store.snapshot().syncedCursor).toBe(null);
  const syncing=store.select(second);
  await store.select(first);
  pending.resolve({messages:[source],cursor:5,receipts:[]});
  await syncing;
  expect(store.snapshot().selected).toBe(first);
  expect(store.snapshot().syncedCursor).toBe(0);
  await store.select(second,source.id);
  expect(store.snapshot().syncedCursor).toBe(5);
  await store.logout();
  await store.select(second,source.id);
  expect(store.snapshot().syncedCursor).toBe(null);
});

test('late source response preserves a read receipt learned while it was in flight',async()=>{
  // Given an in-flight original source and a newer page receipt.
  const store=new ClientStore(),conversation=Id.parse(crypto.randomUUID()),source=message(conversation,2),pending=Promise.withResolvers<unknown>(),readAt='2026-10-02T10:00:00Z';
  reply=async path=>path.startsWith('/v1/sources/')?pending.promise:{messages:[source],cursor:2,receipts:[{message_id:source.id,read_at:readAt}]};
  const opening=store.select(conversation,source.id);await store.select(conversation);
  // When the older source reply arrives with read_at null.
  pending.resolve({message:source,conversation_id:conversation});await opening;
  // Then the newer receipt remains visible.
  expect(store.snapshot().messages[0]?.read_at).toBe(readAt);expect(store.snapshot().messages).toHaveLength(1);
});

test('logout invalidates an in-flight source before it can refill cleared history',async()=>{
  // Given an owned source read that has not returned.
  const store=new ClientStore(),conversation=Id.parse(crypto.randomUUID()),source=message(conversation,200),pending=Promise.withResolvers<unknown>();
  reply=async path=>path.startsWith('/v1/sources/')?pending.promise:{messages:[],cursor:0,receipts:[]};
  const opening=store.select(conversation,source.id);
  // When the session ends before the response is delivered.
  await store.logout();pending.resolve({message:source,conversation_id:conversation});await opening;await store.select(conversation);
  // Then cleared history cannot be repopulated by the old epoch.
  expect(store.snapshot().phase).toBe('login');expect(store.snapshot().messages).toHaveLength(0);
});
