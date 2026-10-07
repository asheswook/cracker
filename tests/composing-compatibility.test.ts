import {expect,test} from "bun:test";
import ky from "ky";
import {z} from "zod";
import {ComposingReceipt} from "../packages/protocol/composing";
import {observeComposing} from "../services/daemon/composing";

const Identity={run_id:z.uuid(),inference_id:z.uuid()};
const LegacyRequest=z.discriminatedUnion("kind",[
  z.object({kind:z.literal("begin"),...Identity,input_message_ids:z.array(z.uuid()).max(100)}).strict(),
  z.object({kind:z.literal("update"),...Identity,generation:z.number().int().positive(),sequence:z.number().int().positive(),status:z.enum(["composing","idle","ended"]),response_id:z.string().min(1).max(256).nullable(),item_id:z.string().min(1).max(256).nullable(),occurred_at:z.iso.datetime()}).strict(),
]);
const LegacyReceipt=z.object({generation:z.number().int().positive()});

for(const rollback of [false,true])test(`new daemon ends typing at text_done against legacy HTTP, mid-inference rollback=${rollback}`,async()=>{
  const pending=new Map<number,ReturnType<typeof Promise.withResolvers<void>>>();
  const waitFor=(sequence:number)=>{const receipt=Promise.withResolvers<void>();pending.set(sequence,receipt);const timeout=setTimeout(()=>receipt.reject(new TypeError(`No accepted update for sequence ${sequence}`)),1000);return receipt.promise.finally(()=>clearTimeout(timeout));};
  const observed:{readonly sequence:number;readonly status:string;readonly http:number}[]=[];
  let serverStatus="idle";
  const server=Bun.serve({port:0,async fetch(request){
    const body=await request.json();
    const parsed=LegacyRequest.safeParse(body);
    if(!parsed.success){
      const rejected=z.object({sequence:z.number(),status:z.string()}).parse(body);
      observed.push({...rejected,http:400});return Response.json({error:"invalid_request"},{status:400});
    }
    const event=parsed.data;
    if(event.kind==="begin")return Response.json({generation:1,...(rollback?{reply_handoff:true}:{})});
    serverStatus=event.status;observed.push({sequence:event.sequence,status:event.status,http:200});pending.get(event.sequence)?.resolve();
    return Response.json({accepted:true});
  }});
  const composing=await observeComposing(ky.create({prefixUrl:server.url.href}),crypto.randomUUID(),[],new AbortController().signal);
  try{
    const started=waitFor(1);composing.observer?.({type:"text_delta",response_id:"response",item_id:"first"});await started;
    expect(serverStatus).toBe("composing");
    const finished=waitFor(2);composing.observer?.({type:"text_done",response_id:"response",item_id:"first"});await finished;
    expect(serverStatus).toBe("idle");
    const next=waitFor(3);composing.observer?.({type:"text_delta",response_id:"response",item_id:"second"});await next;
    expect(serverStatus).toBe("composing");
    const nextDone=waitFor(4);composing.observer?.({type:"text_done",response_id:"response",item_id:"second"});await nextDone;
    expect(serverStatus).toBe("idle");
    const responseDone=waitFor(5);composing.observer?.({type:"response_done",response_id:"response"});await responseDone;
    expect(serverStatus).toBe("ended");
    await composing.deliver(crypto.randomUUID());await composing.close();await composing.close();
    expect(observed.filter(event=>event.http===200).map(event=>event.status)).toEqual(["composing","idle","composing","idle","ended","ended"]);
    expect(observed.filter(event=>event.http===400).map(event=>event.status)).toEqual(rollback?["settling"]:[]);
    console.info(JSON.stringify({scenario:"new-daemon-legacy-http",rollback,requests:observed,finalStatus:serverStatus}));
  }finally{await composing.close();await server.stop(true);}
});

test("receipt negotiation preserves absence and remains readable by legacy daemons",()=>{
  expect(ComposingReceipt.parse({generation:1})).toEqual({generation:1});
  expect(LegacyReceipt.parse({generation:2,reply_handoff:true})).toEqual({generation:2});
});
