import {z} from "zod";
const Identity={run_id:z.uuid(),inference_id:z.uuid()};
const Update={kind:z.literal("update"),...Identity,generation:z.number().int().positive(),sequence:z.number().int().positive(),response_id:z.string().min(1).max(256).nullable(),item_id:z.string().min(1).max(256).nullable(),occurred_at:z.iso.datetime()};
const TextIdentity={response_id:z.string().min(1).max(256),item_id:z.string().min(1).max(256)};
export const ComposingRequest=z.discriminatedUnion("kind",[
  z.object({kind:z.literal("begin"),...Identity,input_message_ids:z.array(z.uuid()).max(100)}).strict(),
  z.discriminatedUnion("status",[
    z.object({...Update,status:z.enum(["composing","idle","ended"])}).strict(),
    z.object({...Update,...TextIdentity,status:z.literal("settling")}).strict(),
    z.object({...Update,...TextIdentity,status:z.literal("delivering"),delivery_event_id:z.uuid()}).strict(),
  ]),
]);
export type ComposingRequest=z.infer<typeof ComposingRequest>;
export const ComposingReceipt=z.object({generation:z.number().int().positive(),reply_handoff:z.literal(true).optional()});
export const ComposingState=z.object({task_id:z.uuid(),run_id:z.uuid(),inference_id:z.uuid(),generation:z.coerce.number().int().positive(),response_id:z.string(),item_id:z.string(),input_message_ids:z.array(z.uuid()),expires_at:z.string()});
export type ComposingState=z.infer<typeof ComposingState>;
export const ReplyHandoffState=z.discriminatedUnion("status",[
  ComposingState.extend({status:z.literal("settling"),delivery_event_id:z.null()}),
  ComposingState.extend({status:z.literal("delivering"),delivery_event_id:z.uuid()}),
]);
export type ReplyHandoffState=z.infer<typeof ReplyHandoffState>;
