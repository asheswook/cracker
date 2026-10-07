import {expect,spyOn,test} from "bun:test";
import {z} from "zod";
import {DaemonPoll} from "../packages/protocol";
import {ComposingReceipt,ReplyHandoffState} from "../packages/protocol/composing";
import * as common from "../services/control/repository/common";
import {composingState,replyHandoffState} from "../services/control/repository/composing";
import {controlFixture} from "./control-fixture";
const f=controlFixture();
async function setup(){
  await f.finishActive();
  await f.sql`UPDATE assistant.vms SET control_state='agent',last_seen_at=now() WHERE id=${f.vm}`;
  await f.sql`UPDATE assistant.commands SET status='applied' WHERE vm_id=${f.vm} AND status='pending'`;
  const task=await f.newTask();
  const assignment=DaemonPoll.parse(await(await f.request('/v1/daemon/poll',f.machine)).json()).assignment;
  if(!assignment)throw new TypeError("No assignment");
  const run_id=assignment.run_id,conversation=task.message.conversation_id;
  const begin=async()=>{
    const inference_id=crypto.randomUUID();
    const response=await f.request('/v1/daemon/composing',f.machine,{kind:'begin',run_id,inference_id,input_message_ids:[task.message.id]});
    expect(response.status).toBe(200);
    const receipt=ComposingReceipt.parse(await response.json());
    expect(receipt.reply_handoff).toBe(true);
    return {inference_id,generation:receipt.generation};
  };
  const token=await begin();
  const update=async(sequence:number,status:string,extra:Readonly<Record<string,unknown>>={})=>{
    const response=await f.request('/v1/daemon/composing',f.machine,{kind:'update',run_id,...token,sequence,status,response_id:'response',item_id:'reply',occurred_at:new Date().toISOString(),...extra});
    return response;
  };
  expect((await f.request('/v1/daemon/events',f.machine,{kind:'input_applied',run_id,event_id:crypto.randomUUID(),message_id:task.message.id})).status).toBe(200);
  expect((await update(1,'composing')).status).toBe(200);
  expect(await composingState(f.sql,f.workspace,conversation)).not.toBeNull();
  const state=()=>replyHandoffState(f.sql,f.workspace,conversation);
  const message=async(event_id:string)=>f.request('/v1/daemon/events',f.machine,{kind:'message',run_id,event_id,content:'Actual answer'});
  return {task,run_id,conversation,token,begin,update,state,message};
}
test('settling retains handoff through 650ms delayed publication without reporting typing',async()=>{
  const s=await setup();
  // Given visible composing text has finished, but final response validation has not.
  expect((await s.update(2,'settling')).status).toBe(200);
  const settling=await s.state();
  expect(settling?.status).toBe('settling');
  expect(await composingState(f.sql,f.workspace,s.conversation)).toBeNull();
  const event=crypto.randomUUID();
  // When durable publication is deliberately delayed by the test's database clock barrier.
  await f.sql`SELECT pg_sleep(0.65)`;
  expect((await s.update(3,'delivering',{delivery_event_id:event})).status).toBe(200);
  const delivering=await s.state();
  expect(delivering?.status).toBe('delivering');
  expect(delivering?.expires_at).toBe(settling?.expires_at);
  expect((await s.message(event)).status).toBe(200);
  // Then committed message and cleared handoff are visible together.
  expect(await s.state()).toBeNull();
  const messages=await f.sql`SELECT id FROM assistant.messages WHERE task_id=${s.task.task.id} AND role='assistant'`;
  expect(messages).toHaveLength(1);
});
test('message commit before late delivering update cannot revive handoff',async()=>{
  const s=await setup();await s.update(2,'settling');
  const event=crypto.randomUUID();
  expect((await s.message(event)).status).toBe(200);
  // When delivery metadata arrives after the message transaction.
  expect((await s.update(3,'delivering',{delivery_event_id:event})).status).toBe(200);
  // Then later retries cannot resurrect the reservation.
  expect(await s.state()).toBeNull();
  await s.update(4,'delivering',{delivery_event_id:event});
  expect(await s.state()).toBeNull();
});
test('wrong event and duplicate old message retry preserve newer delivery handoff',async()=>{
  const s=await setup(),old=crypto.randomUUID();
  await s.message(old);await s.begin();
  const token=await s.begin();
  await s.update(1,'composing',token);await s.update(2,'settling',token);
  const event=crypto.randomUUID();await s.update(3,'delivering',{...token,delivery_event_id:event});
  // When unrelated and duplicate already-applied messages arrive.
  expect((await s.message(crypto.randomUUID())).status).toBe(200);
  expect((await s.message(old)).status).toBe(200);
  // Then only the correlated message clears the reservation.
  expect((await s.state())?.delivery_event_id).toBe(event);
  await s.message(event);expect(await s.state()).toBeNull();
});
test('abort and no-reply ended updates tombstone handoff',async()=>{
  const s=await setup();await s.update(2,'settling');
  // When final validation rejects the reply or execution aborts.
  await s.update(3,'ended');await s.update(4,'delivering',{delivery_event_id:crypto.randomUUID()});
  // Then a late delivery cannot revive it.
  expect(await s.state()).toBeNull();
});
test('handoff lease stays anchored across retries and expires without revival',async()=>{
  const s=await setup();await s.update(2,'settling',{occurred_at:new Date(Date.now()-2000).toISOString()});
  const initial=await s.state();expect(initial).not.toBeNull();
  // When fresh retries attempt to extend the original reservation.
  await s.update(3,'settling');await s.update(4,'delivering',{delivery_event_id:crypto.randomUUID()});
  expect((await s.state())?.expires_at).toBe(initial?.expires_at);
  await f.sql`UPDATE assistant.reply_composing SET expires_at=now()-interval '1 second' WHERE run_id=${s.run_id}`;
  await s.update(5,'settling');
  // Then expired reservations remain absent.
  expect(await s.state()).toBeNull();
});
test('stale generation and next inference cannot inherit handoff',async()=>{
  const s=await setup();await s.update(2,'settling');
  // When a new inference supersedes the old generation.
  const next=await s.begin();await s.update(50,'delivering',{delivery_event_id:crypto.randomUUID()});
  // Then stale delivery is absent, while current typing still works.
  expect(await s.state()).toBeNull();
  await s.update(1,'composing',next);
  expect((await composingState(f.sql,f.workspace,s.conversation))?.inference_id).toBe(next.inference_id);
});
test('unread new input and alien workspace suppress handoff',async()=>{
  const s=await setup();await s.update(2,'settling');
  expect(await replyHandoffState(f.sql,f.alien,s.conversation)).toBeNull();
  // When new user input supersedes the reply inputs.
  const response=await f.request(`/v1/conversations/${s.conversation}/messages`,f.client,{client_message_id:crypto.randomUUID(),content:'New steering'});
  expect(response.status).toBe(200);
  // Then the old reservation is not eligible.
  expect(await s.state()).toBeNull();
});
test.each(['takeover','cancel'] as const)('%s suppresses handoff immediately',async(action)=>{
  const s=await setup();await s.update(2,'settling');
  // When control or cancellation invalidates the active run.
  const response=action==='takeover'?await f.request(`/v1/vms/${f.vm}/control`,f.client,{kind:'takeover'}):await f.request(`/v1/tasks/${s.task.task.id}/stop`,f.client,{});
  expect(response.status).toBe(200);
  // Then no handoff remains eligible.
  expect(await s.state()).toBeNull();
});
test('existing non-message event cannot authorize completed delivery',async()=>{
  const s=await setup();await s.update(2,'settling');
  const event_id=crypto.randomUUID();
  expect((await f.request('/v1/daemon/events',f.machine,{kind:'heartbeat',run_id:s.run_id,event_id})).status).toBe(200);
  // When a delivery references an event with the wrong kind.
  const response=await s.update(3,'delivering',{delivery_event_id:event_id});
  // Then it is rejected without clearing settling.
  expect(response.status).toBe(409);expect((await s.state())?.status).toBe('settling');
});
test('stale source timestamp cannot start handoff',async()=>{
  const s=await setup();
  // When a delayed transition is already beyond its source lease.
  await s.update(2,'settling',{occurred_at:new Date(Date.now()-6000).toISOString()});
  // Then no new handoff is created.
  expect(await s.state()).toBeNull();
});
test('different response or item cannot reuse visible text identity',async()=>{
  const s=await setup();
  await s.update(2,'settling',{response_id:'other-response'});
  expect(await s.state()).toBeNull();
  await s.update(3,'settling',{item_id:'other-item'});
  expect(await s.state()).toBeNull();
});
test('new text item in the same response resumes typing after settling without reviving old text',async()=>{
  const s=await setup();await s.update(2,'settling');
  await s.update(3,'composing');
  expect(await composingState(f.sql,f.workspace,s.conversation)).toBeNull();
  await s.update(4,'composing',{item_id:'second-reply'});
  expect((await composingState(f.sql,f.workspace,s.conversation))?.item_id).toBe('second-reply');
  expect(await s.state()).toBeNull();
  await s.update(5,'settling',{item_id:'second-reply'});
  await s.update(6,'delivering',{item_id:'second-reply',delivery_event_id:crypto.randomUUID()});
  await s.update(7,'composing',{item_id:'third-reply'});
  expect(await composingState(f.sql,f.workspace,s.conversation)).toBeNull();
  expect((await s.state())?.status).toBe('delivering');
});
test('missing input receipt and expired VM heartbeat suppress handoff',async()=>{
  const s=await setup();await s.update(2,'settling');
  await f.sql`DELETE FROM assistant.input_receipts WHERE run_id=${s.run_id}`;
  expect(await s.state()).toBeNull();
  await f.request('/v1/daemon/events',f.machine,{kind:'input_applied',run_id:s.run_id,event_id:crypto.randomUUID(),message_id:s.task.message.id});
  expect(await s.state()).not.toBeNull();
  await f.sql`UPDATE assistant.vms SET last_seen_at=now()-interval '61 seconds' WHERE id=${f.vm}`;
  expect(await s.state()).toBeNull();
});
test('already-applied message from another run cannot complete this handoff',async()=>{
  const previous=await setup(),event=crypto.randomUUID();await previous.message(event);
  const s=await setup();await s.update(2,'settling');
  expect((await s.update(3,'delivering',{delivery_event_id:event})).status).toBe(409);
  expect((await s.state())?.status).toBe('settling');
});
test('legacy server clear begin and update SQL remain valid after delivering state',async()=>{
  const s=await setup();await s.update(2,'settling');
  await s.update(3,'delivering',{delivery_event_id:crypto.randomUUID()});
  await f.sql`UPDATE assistant.reply_composing SET status='ended',expires_at=now() WHERE run_id=${s.run_id}`;
  expect(await s.state()).toBeNull();
  const inference=crypto.randomUUID();
  await f.sql`INSERT INTO assistant.reply_composing(run_id,inference_id,generation,input_message_ids) VALUES(${s.run_id},${inference},1,${[s.task.message.id]}) ON CONFLICT(run_id) DO UPDATE SET inference_id=EXCLUDED.inference_id,generation=reply_composing.generation+1,sequence=0,status='idle',response_id=NULL,item_id=NULL,input_message_ids=EXCLUDED.input_message_ids,expires_at=now()`;
  await f.sql`UPDATE assistant.reply_composing SET sequence=1,status='composing',response_id='legacy-response',item_id='legacy-item',expires_at=now()+interval '5 seconds' WHERE run_id=${s.run_id} AND inference_id=${inference} AND status<>'ended'`;
  expect((await composingState(f.sql,f.workspace,s.conversation))?.inference_id).toBe(inference);
  expect(await s.state()).toBeNull();
});
test('message page atomically preserves handoff across concurrent message publication',async()=>{
  const s=await setup(),event=crypto.randomUUID();
  await s.update(2,'settling');await s.update(3,'delivering',{delivery_event_id:event});
  const selected=Promise.withResolvers<void>(),resume=Promise.withResolvers<void>();
  const original=common.messages;
  const read=spyOn(common,'messages').mockImplementation(async(...args)=>{
    const rows=await original(...args);selected.resolve();await resume.promise;return rows;
  });
  const path=`/v1/conversations/${s.conversation}/messages?after=${s.task.message.sequence}`;
  const pending=f.request(path);
  let timer:ReturnType<typeof setTimeout>|undefined;
  const deadline=new Promise<never>((_,reject)=>{timer=setTimeout(()=>reject(new TypeError('Snapshot barrier timed out')),3000);});
  const Page=z.object({messages:z.array(z.object({content:z.string()})),reply_handoff:ReplyHandoffState.nullable()});
  try{
    // When the actual message transaction commits between the snapshot's SELECTs.
    await Promise.race([selected.promise,deadline]);
    expect((await s.message(event)).status).toBe(200);resume.resolve();
    const response=await Promise.race([pending,deadline]);
    const before=Page.parse(await response.json());
    // Then the held snapshot preserves the handoff; the next one contains the reply only.
    expect(before.messages).toEqual([]);expect(before.reply_handoff?.delivery_event_id).toBe(event);
    read.mockRestore();
    const after=Page.parse(await(await f.request(path)).json());
    expect(after.messages.map(m=>m.content)).toEqual(['Actual answer']);expect(after.reply_handoff).toBeNull();
    console.info(JSON.stringify({scenario:'atomic-handoff-snapshot',before:{messages:before.messages.length,handoff:before.reply_handoff?.status},after:{messages:after.messages.length,handoff:after.reply_handoff}}));
  }finally{resume.resolve();clearTimeout(timer);read.mockRestore();await pending;}
});
