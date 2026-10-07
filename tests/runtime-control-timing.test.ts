import {test,expect,spyOn} from 'bun:test';
import {setTimeout as delay} from 'node:timers/promises';
import {Runtime,type ControlTiming} from '../services/daemon/runtime.ts';
import {Journal} from '../services/daemon/journal.ts';
import {ToolExecutor} from '../services/daemon/tools.ts';
import {DaemonEvent,type Command} from '../packages/protocol/index.ts';
test('control timing separates poll, release barrier, ACK and heartbeat without request data',async()=>{
 const timings:ControlTiming[]=[],events:DaemonEvent[]=[];
 let command:Command={id:crypto.randomUUID(),task_id:null,kind:'takeover',created_at:new Date().toISOString()};
 const server=Bun.serve({port:0,async fetch(request){
  const path=new URL(request.url).pathname;
  if(path==='/v1/daemon/poll'){await delay(25);return Response.json({assignment:null,commands:[command],messages:[]});}
  if(path==='/v1/daemon/events'){events.push(DaemonEvent.parse(await request.json()));await delay(15);return Response.json({accepted:true});}
  return Response.json({skills:[],servers:[]});
 }}),journal=new Journal(':memory:');
 const runtime=new Runtime({controlUrl:server.url.href,token:'synthetic-private-token',journal,tools:new ToolExecutor(),provider:{respond:async()=>{throw new TypeError('Idle fixture');}},inputBarrier:()=>delay(35),releaseInput:()=>delay(20),onControlTiming:event=>timings.push(event)});
 try{
  await runtime.tick();command={...command,id:crypto.randomUUID(),kind:'return_control'};await runtime.tick();
  expect(events.filter(e=>e.kind==='command_ack').map(e=>e.status)).toEqual(['applied','applied']);
  expect(timings.filter(t=>t.phase==='poll')).toHaveLength(2);
  expect(timings.filter(t=>t.phase==='poll').every(t=>t.duration_ms>=20)).toBe(true);
  expect(timings.filter(t=>t.phase==='local_barrier').map(t=>t.outcome)).toEqual(['completed','completed']);
  expect(timings.find(t=>t.phase==='local_barrier')?.duration_ms).toBeGreaterThanOrEqual(30);
  const deliveries=timings.filter(t=>t.phase==='event_delivery');
  expect(deliveries.map(t=>t.event_kind)).toEqual(['command_ack','heartbeat','command_ack']);
  expect(deliveries.every(t=>t.duration_ms>=10)).toBe(true);
  for(const event of timings){expect(Object.keys(event).every(key=>['phase','command_id','event_kind','started_at','duration_ms','outcome'].includes(key))).toBe(true);expect(Number.isNaN(Date.parse(event.started_at))).toBe(false);}
  expect(JSON.stringify(timings)).not.toContain('synthetic-private-token');
 }finally{await runtime.stop();journal.close();await server.stop(true);}
});

test('heartbeat cadence preserves first delivery and durable retry without duplicating every poll',async()=>{
 let now=0,polls=0,fail=true;const delivered:DaemonEvent[]=[];
 const clock=spyOn(performance,"now").mockImplementation(()=>now);
 const server=Bun.serve({port:0,async fetch(request){
  const path=new URL(request.url).pathname;
  if(path==="/v1/daemon/poll"){polls++;return Response.json({assignment:null,commands:[],messages:[]});}
  if(path==="/v1/daemon/events"){const event=DaemonEvent.parse(await request.json());delivered.push(event);if(fail){fail=false;return new Response("unavailable",{status:503});}return Response.json({accepted:true});}
  return Response.json({skills:[],servers:[]});
 }}),journal=new Journal(":memory:");
 const runtime=new Runtime({controlUrl:server.url.href,token:"fixture",journal,tools:new ToolExecutor(),provider:{respond:async()=>{throw new TypeError("idle");}}});
 try{
  await expect(runtime.tick()).rejects.toThrow();expect(journal.pending()).toHaveLength(1);
  now=1000;await runtime.tick();expect(journal.pending()).toHaveLength(0);
  now=14999;await runtime.tick();expect(delivered).toHaveLength(2);expect(delivered[0]?.event_id).toBe(delivered[1]?.event_id);
  now=15000;await runtime.tick();expect(delivered).toHaveLength(3);expect(delivered[2]?.event_id).not.toBe(delivered[0]?.event_id);expect(polls).toBe(4);
 }finally{clock.mockRestore();await runtime.stop();journal.close();await server.stop(true);}
});
