import {z} from 'zod';
import {ProviderError} from './errors.ts';
const ApiCode=z.enum(['invalid_request_error','invalid_api_key','invalid_model','model_not_found','unsupported_parameter','unsupported_value','invalid_value','insufficient_scope','permission_denied','rate_limit_exceeded','websocket_connection_limit_reached','websocket_stream_limit_reached','invalid_stream_id']);
const Parameter=z.enum(['service_tier','max_output_tokens','stream_id','model','reasoning','store','include','previous_response_id']);
const ApiError=z.object({code:ApiCode.nullish(),type:ApiCode.nullish(),param:Parameter.nullish(),message:z.string().optional()});
const SocketError=z.object({error:z.unknown().optional()});
export type SocketDiagnostic={readonly event_type?:string;readonly http_status:number|null;readonly api_code:string|null;readonly parameter:string|null;readonly message_category:string;readonly mentioned_parameters:readonly string[]};
export function socketDiagnostic(error:unknown):SocketDiagnostic{
 const outer=SocketError.safeParse(error);const wire=outer.success?outer.data.error:undefined;
 const nested=SocketError.safeParse(wire);const parsed=ApiError.safeParse(nested.success&&nested.data.error?nested.data.error:wire);
 const status=error instanceof Error?/^Unexpected server response: ([1-5][0-9]{2})$/.exec(error.message):null;
 const message=parsed.success?(parsed.data.message??'').toLowerCase():'';
 const mentioned=Parameter.options.filter(parameter=>message.includes(parameter));
 const unsupported=/unsupported|not supported|not available|not allowed/.test(message);
 let category='unknown';
 if(unsupported&&/oauth|subscription|chatgpt|sign in/.test(message))category='oauth_or_subscription_unsupported';
 else if(unsupported&&mentioned.length>0)category='parameter_unsupported';
 else if(unsupported&&/websocket|web socket/.test(message))category='websocket_unsupported';
 else if(/quota|rate limit|rate_limit/.test(message))category='quota_or_rate_limit';
 else if(/unauthorized|permission denied|invalid api key|authentication|not authorized/.test(message))category='authorization_denied';
 else if(mentioned.includes('stream_id')&&/invalid|missing|required/.test(message))category='stream_id_invalid_or_missing';
 return {message_category:category,mentioned_parameters:mentioned,http_status:status?.[1]?Number(status[1]):null,api_code:parsed.success?parsed.data.code??parsed.data.type??null:null,parameter:parsed.success?parsed.data.param??null:null};
}
const reasons:Readonly<Record<string,string>>={
 'WebSocket unexpected named event':'unexpected_named_event','WebSocket output item limit exceeded':'output_item_limit','WebSocket output item identity mismatch':'output_item_identity_mismatch',
 'WebSocket provider is closed':'provider_closed','WebSocket concurrent request limit reached':'concurrency_limit','WebSocket requires full history and default service tier':'configuration_contract','WebSocket request aborted':'aborted','WebSocket request timed out':'timeout','WebSocket returned an unexpected service tier':'unexpected_tier','WebSocket response failed validation or transport':'response_validation','WebSocket transport failed':'transport_error','WebSocket closed before completion':'connection_closed','WebSocket event lacks stream correlation':'missing_stream_id','WebSocket event type is unsupported':'unsupported_event_type','WebSocket request failed':'request_error','WebSocket response identity changed':'response_identity_changed','WebSocket event preceded response identity':'missing_response_created','WebSocket terminal identity mismatch':'terminal_identity_mismatch','WebSocket returned an unsupported raw frame':'raw_frame','Provider completed without output':'empty_output','Provider did not complete the response':'response_incomplete','Provider stream ended before response.completed':'stream_ended',
};
export function providerFailure(error:unknown){return {reason:error instanceof ProviderError?reasons[error.message]??'provider_error':'non_provider_error',...(error instanceof ProviderError&&error.diagnostic?error.diagnostic:{http_status:null,api_code:null,parameter:null,message_category:'unknown',mentioned_parameters:[]})};}

export function unsupportedEventDiagnostic(type:string):SocketDiagnostic{
 const name=z.string().regex(/^[a-z][a-z0-9_.]{0,100}$/).safeParse(type);
 return {http_status:null,api_code:null,parameter:null,message_category:'unknown',mentioned_parameters:[],...(name.success?{event_type:name.data}:{})};
}
