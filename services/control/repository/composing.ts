import {ComposingReceipt,ComposingState,ReplyHandoffState,type ComposingRequest} from "../../../packages/protocol/composing";
import {DomainError} from "../../../packages/protocol";
import type {Principal} from "../auth";
import type {Query} from "../db";
import {loadRun} from "./runs";
export async function clearComposing(sql:Query,run:string){await sql`UPDATE assistant.reply_composing SET status='ended',delivery_event_id=NULL,expires_at=now() WHERE run_id=${run}`;}
export async function clearDeliveredComposing(sql:Query,run:string,eventId:string){
  await sql`UPDATE assistant.reply_composing SET status='ended',delivery_event_id=NULL,expires_at=now() WHERE run_id=${run} AND (status IN ('idle','composing') OR (status='delivering' AND delivery_event_id=${eventId}))`;
}

export async function updateComposing(sql:Query,principal:Principal,event:ComposingRequest){
  await sql`SELECT id FROM assistant.vms WHERE id=${principal.vm_id} FOR UPDATE`;
  const run=await loadRun(sql,principal,event.run_id);
  const usable=await sql`SELECT t.id FROM assistant.tasks t JOIN assistant.vms v ON v.id=${principal.vm_id} WHERE t.id=${run.task_id} AND t.state='running' AND ${run.state}='running' AND v.control_state='agent' AND NOT EXISTS(SELECT 1 FROM assistant.commands c WHERE c.vm_id=v.id AND c.status='pending')`;
  if(!usable.length)throw new DomainError("stale_run","Run cannot compose a reply",409);
  if(event.kind==="begin"){
    const rows=await sql`INSERT INTO assistant.reply_composing(run_id,inference_id,generation,input_message_ids) VALUES(${run.id},${event.inference_id},1,${event.input_message_ids}) ON CONFLICT(run_id) DO UPDATE SET inference_id=EXCLUDED.inference_id,generation=reply_composing.generation+1,sequence=0,status='idle',response_id=NULL,item_id=NULL,delivery_event_id=NULL,input_message_ids=EXCLUDED.input_message_ids,expires_at=now() RETURNING generation`;
    return {...ComposingReceipt.parse(rows[0]),reply_handoff:true as const};
  }
  if(event.status==="composing"&&(!event.response_id||!event.item_id))throw new DomainError("invalid_composing","Reply text identity is required",400);
  if(event.status==='settling'||event.status==='delivering'){
    const deliveryEventId=event.status==='delivering'?event.delivery_event_id:null;
    if(deliveryEventId){
      const conflict=await sql`SELECT event_id FROM assistant.events WHERE event_id=${deliveryEventId} AND NOT (workspace_id=${principal.workspace_id} AND vm_id=${principal.vm_id} AND kind='message' AND payload->>'run_id'=${run.id})`;
      if(conflict.length)throw new DomainError('invalid_delivery_event','Delivery event identity mismatch',409);
    }
    await sql`UPDATE assistant.reply_composing c SET sequence=${event.sequence},status=CASE WHEN EXISTS(SELECT 1 FROM assistant.events e WHERE e.event_id=${deliveryEventId} AND e.workspace_id=${principal.workspace_id} AND e.vm_id=${principal.vm_id} AND e.kind='message' AND e.payload->>'run_id'=${run.id}) THEN 'ended' ELSE ${event.status} END,delivery_event_id=CASE WHEN EXISTS(SELECT 1 FROM assistant.events e WHERE e.event_id=${deliveryEventId}) THEN NULL ELSE ${deliveryEventId}::uuid END,response_id=${event.response_id},item_id=${event.item_id},expires_at=LEAST(now()+interval '5 seconds',${event.occurred_at}::timestamptz+interval '5 seconds',CASE WHEN c.status IN ('settling','delivering') THEN c.expires_at ELSE 'infinity'::timestamptz END) WHERE run_id=${run.id} AND inference_id=${event.inference_id} AND generation=${event.generation} AND sequence<${event.sequence} AND status IN ('composing','settling','delivering') AND c.expires_at>now() AND (c.status<>'delivering' OR (${event.status}='delivering' AND c.delivery_event_id=${deliveryEventId})) AND c.response_id=${event.response_id} AND c.item_id=${event.item_id} AND ${event.occurred_at}::timestamptz BETWEEN now()-interval '5 seconds' AND now()+interval '2 seconds'`;
    return {accepted:true};
  }
  await sql`UPDATE assistant.reply_composing SET sequence=${event.sequence},status=${event.status},delivery_event_id=NULL,response_id=${event.response_id},item_id=${event.item_id},expires_at=LEAST(now()+interval '5 seconds',${event.occurred_at}::timestamptz+interval '5 seconds') WHERE run_id=${run.id} AND inference_id=${event.inference_id} AND generation=${event.generation} AND sequence<${event.sequence} AND status<>'ended' AND (${event.status}<>'composing' OR ((status NOT IN ('settling','delivering') OR (status='settling' AND item_id<>${event.item_id})) AND ${event.occurred_at}::timestamptz BETWEEN now()-interval '5 seconds' AND now()+interval '2 seconds' AND (response_id IS NULL OR response_id=${event.response_id})))`;
  return {accepted:true};
}

export async function composingState(sql:Query,workspace:string,conversation:string){
  const rows=await sql`SELECT t.id AS task_id,r.id AS run_id,c.inference_id,c.generation,c.response_id,c.item_id,c.input_message_ids,c.expires_at FROM assistant.reply_composing c JOIN assistant.runs r ON r.id=c.run_id JOIN assistant.tasks t ON t.id=r.task_id JOIN assistant.vms v ON v.id=r.vm_id WHERE r.workspace_id=${workspace} AND t.conversation_id=${conversation} AND r.state='running' AND t.state='running' AND v.control_state='agent' AND v.last_seen_at>now()-interval '60 seconds' AND c.status='composing' AND c.expires_at>now() AND NOT EXISTS(SELECT 1 FROM assistant.commands cmd WHERE cmd.vm_id=v.id AND cmd.status='pending') AND NOT EXISTS(SELECT 1 FROM unnest(c.input_message_ids) requested(id) WHERE NOT EXISTS(SELECT 1 FROM assistant.input_receipts i JOIN assistant.messages m ON m.id=i.message_id WHERE i.run_id=r.id AND i.workspace_id=${workspace} AND m.conversation_id=t.conversation_id AND m.id=requested.id)) AND NOT EXISTS(SELECT 1 FROM assistant.messages latest WHERE latest.id=(SELECT m.id FROM assistant.messages m WHERE m.workspace_id=${workspace} AND m.conversation_id=t.conversation_id AND m.role='user' ORDER BY sequence DESC LIMIT 1) AND NOT(latest.id=ANY(c.input_message_ids))) ORDER BY c.generation DESC LIMIT 1`;
  return rows[0]?ComposingState.parse(rows[0]):null;
}

export async function replyHandoffState(sql:Query,workspace:string,conversation:string){
  const rows=await sql`SELECT t.id AS task_id,r.id AS run_id,c.inference_id,c.generation,c.response_id,c.item_id,c.input_message_ids,c.expires_at,c.status,c.delivery_event_id FROM assistant.reply_composing c JOIN assistant.runs r ON r.id=c.run_id JOIN assistant.tasks t ON t.id=r.task_id JOIN assistant.vms v ON v.id=r.vm_id WHERE r.workspace_id=${workspace} AND t.conversation_id=${conversation} AND r.state='running' AND t.state='running' AND v.control_state='agent' AND v.last_seen_at>now()-interval '60 seconds' AND c.status IN ('settling','delivering') AND c.expires_at>now() AND NOT EXISTS(SELECT 1 FROM assistant.commands cmd WHERE cmd.vm_id=v.id AND cmd.status='pending') AND NOT EXISTS(SELECT 1 FROM unnest(c.input_message_ids) requested(id) WHERE NOT EXISTS(SELECT 1 FROM assistant.input_receipts i JOIN assistant.messages m ON m.id=i.message_id WHERE i.run_id=r.id AND i.workspace_id=${workspace} AND m.conversation_id=t.conversation_id AND m.id=requested.id)) AND NOT EXISTS(SELECT 1 FROM assistant.messages latest WHERE latest.id=(SELECT m.id FROM assistant.messages m WHERE m.workspace_id=${workspace} AND m.conversation_id=t.conversation_id AND m.role='user' ORDER BY sequence DESC LIMIT 1) AND NOT(latest.id=ANY(c.input_message_ids))) ORDER BY c.generation DESC LIMIT 1`;
  return rows[0]?ReplyHandoffState.parse(rows[0]):null;
}
