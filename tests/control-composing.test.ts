import {test,expect} from "bun:test";
import {z} from "zod";
import {DaemonPoll,Message,Task} from "../packages/protocol";
import {ComposingReceipt,ComposingState} from "../packages/protocol/composing";
import {controlFixture} from "./control-fixture";
const f=controlFixture();
const Page=z.object({composing:ComposingState.nullable()});
async function setup(){
  await f.finishActive();
  const task=await f.newTask();
  const assignment=DaemonPoll.parse(await(await f.request('/v1/daemon/poll',f.machine)).json()).assignment;
  if(!assignment)throw new TypeError("No assignment");
  const run=assignment.run_id,path=`/v1/conversations/${task.message.conversation_id}/messages`;
  const begin=async(ids=[task.message.id])=>{
    const inference_id=crypto.randomUUID();
    const res=await f.request('/v1/daemon/composing',f.machine,{kind:"begin",run_id:run,inference_id,input_message_ids:ids});
    expect(res.status).toBe(200);
    return {inference_id,generation:ComposingReceipt.parse(await res.json()).generation};
  };
  const update=async(token:{inference_id:string;generation:number},sequence:number,status="composing",occurred_at=new Date().toISOString())=>{
    const res=await f.request('/v1/daemon/composing',f.machine,{kind:"update",run_id:run,...token,sequence,status,response_id:"response-1",item_id:"reply",occurred_at});
    expect(res.status).toBe(200);
  };
  const read=async(message=task.message.id)=>f.request('/v1/daemon/events',f.machine,{kind:"input_applied",run_id:run,event_id:crypto.randomUUID(),message_id:message});
  const state=async()=>Page.parse(await(await f.request(path)).json()).composing;
  return {task,run,path,begin,update,read,state};
}
test("composing requires exact applied latest input, never promotes later steering to read",async()=>{
  const s=await setup(),token=await s.begin();
  await s.update(token,1);expect(await s.state()).toBeNull();
  await s.read();expect((await s.state())?.input_message_ids).toEqual([s.task.message.id]);
  const later=z.object({message:Message,task:Task}).parse(await(await f.request(s.path,f.client,{content:"new steering",client_message_id:crypto.randomUUID()})).json());
  expect(later.task.id).toBe(s.task.task.id);expect(await s.state()).toBeNull();
  await s.read(later.message.id);expect(await s.state()).toBeNull();
  const next=await s.begin([s.task.message.id,later.message.id]);await s.update(next,1);
  expect((await s.state())?.inference_id).toBe(next.inference_id);
  expect((await f.request(s.path,f.alienToken)).status).toBe(404);
});
test("done tombstones, stale deltas and previous inference generations cannot revive typing",async()=>{
  const s=await setup();await s.read();const old=await s.begin();await s.update(old,1);
  await s.update(old,2,"ended");await s.update(old,3);expect(await s.state()).toBeNull();
  const current=await s.begin();await s.update(old,50);expect(await s.state()).toBeNull();
  await s.update(current,1,"composing",new Date(Date.now()-10000).toISOString());expect(await s.state()).toBeNull();
  await s.update(current,2);expect((await s.state())?.generation).toBe(current.generation);
  await s.update(current,1,"idle");expect(await s.state()).not.toBeNull();
  await f.sql`UPDATE assistant.reply_composing SET expires_at=now()-interval '1 second' WHERE run_id=${s.run}`;
  expect(await s.state()).toBeNull();
});
test("reply delivery clears composing and control handoff suppresses active typing",async()=>{
  const s=await setup();await s.read();const token=await s.begin();await s.update(token,1);
  await f.request('/v1/daemon/events',f.machine,{kind:"message",run_id:s.run,event_id:crypto.randomUUID(),content:"Actual answer"});
  await s.update(token,2);expect(await s.state()).toBeNull();
  const next=await s.begin();await s.update(next,1);expect(await s.state()).not.toBeNull();
  await f.request(`/v1/vms/${f.vm}/control`,f.client,{kind:"takeover"});expect(await s.state()).toBeNull();
});
