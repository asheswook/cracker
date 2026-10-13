import type { Response, ResponseStreamEvent, ResponseOutputItem } from "openai/resources/responses/responses";
import {ProviderError} from "./errors.ts";
import { describeApiFailure, ProviderStreamError } from './api-failure.ts';
export type ProviderResponseEvent =
  | {readonly type:"text_delta"|"text_done";readonly response_id:string;readonly item_id:string}
  | {readonly type:"response_done";readonly response_id:string};
export type ProviderResponseObserver = (event:ProviderResponseEvent)=>void;
export async function consumeResponse(stream: AsyncIterable<ResponseStreamEvent>,observer?:ProviderResponseObserver): Promise<Response> {
  const completed = new Map<number, ResponseOutputItem>();
  const messages=new Set<string>(),active=new Set<string>();
  let responseId:string|undefined;
  try {
  for await (const event of stream) {
    if(event.type==="response.created")responseId=event.response.id;
    if(event.type==="response.output_item.added"&&event.item.type==="message"&&event.item.role==="assistant")messages.add(event.item.id);
    if(event.type==="response.output_text.delta"&&event.delta.trim()&&responseId&&messages.has(event.item_id)){
      active.add(event.item_id);observer?.({type:"text_delta",response_id:responseId,item_id:event.item_id});
    }
    const stopped=event.type==="response.output_text.done"?event.item_id:event.type==="response.output_item.done"?event.item.id:undefined;
    if(stopped&&responseId&&active.delete(stopped))observer?.({type:"text_done",response_id:responseId,item_id:stopped});
    if (event.type === "response.output_item.done") completed.set(event.output_index, event.item);
    if (event.type === "response.completed") {
      const output = event.response.output.length > 0 ? event.response.output : [...completed.entries()].sort(([a], [b]) => a - b).map(([, item]) => item);
      if (output.length === 0) throw new ProviderError("incomplete", "Provider completed without output");
      const output_text = output.flatMap(item => item.type === "message" ? item.content.flatMap(content => content.type === "output_text" ? [content.text] : []) : []).join("");
      return { ...event.response, output, output_text };
    }
    if(event.type==='error')throw new ProviderStreamError({...describeApiFailure(event,event.message,null),event_type:event.type});
    if(event.type==='response.failed'||event.type==='response.incomplete'){
      const failure=describeApiFailure(event.response.error,event.response.error?.message??'',null);
      if(event.type==='response.incomplete'){
        const reason=event.response.incomplete_details?.reason;
        const incomplete_reason=reason==='max_output_tokens'||reason==='content_filter'?reason:'unknown';
        throw new ProviderStreamError({...failure,retryable:failure.retryable&&!reason,event_type:event.type,incomplete_reason});
      }
      throw new ProviderStreamError({...failure,event_type:event.type});
    }
  }
  throw new ProviderError("incomplete", "Provider stream ended before response.completed");
  } finally {
    if(responseId)observer?.({type:"response_done",response_id:responseId});
  }
}
