import {test,expect} from 'bun:test';
import {socketDiagnostic,providerFailure,unsupportedEventDiagnostic} from '../packages/provider/diagnostic.ts';
import {ProviderError} from '../packages/provider/errors.ts';
test('WebSocket diagnostic exposes only allowlisted status/code/parameter',()=>{
 expect(socketDiagnostic(new Error('Unexpected server response: 403'))).toEqual({http_status:403,api_code:null,parameter:null,message_category:'unknown',mentioned_parameters:[]});
 expect(socketDiagnostic({error:{type:'error',error:{code:'unsupported_parameter',param:'service_tier',message:'synthetic-secret'}}})).toEqual({http_status:null,api_code:'unsupported_parameter',parameter:'service_tier',message_category:'unknown',mentioned_parameters:[]});
 const secret='synthetic-secret';
 for(const input of [new Error(secret),{error:{code:secret,param:secret,message:secret}},secret])expect(JSON.stringify(socketDiagnostic(input))).not.toContain(secret);
 expect(providerFailure(new ProviderError('incomplete','WebSocket event lacks stream correlation')).reason).toBe('missing_stream_id');
 expect(JSON.stringify(providerFailure(new ProviderError('incomplete',secret)))).not.toContain(secret);
});

test('error text only selects fixed categories and known parameter names',()=>{
 const result=socketDiagnostic({error:{error:{code:'invalid_request_error',message:'service_tier is not supported for Sign in with ChatGPT; synthetic-secret'}}});
 expect(result.message_category).toBe('oauth_or_subscription_unsupported');expect(result.mentioned_parameters).toEqual(['service_tier']);expect(JSON.stringify(result)).not.toContain('synthetic-secret');
});

test('unknown wire event diagnostic allows only bounded protocol typename',()=>{
 expect(unsupportedEventDiagnostic('response.new_event').event_type).toBe('response.new_event');
 expect(unsupportedEventDiagnostic('Authorization: synthetic-secret').event_type).toBeUndefined();
 expect(unsupportedEventDiagnostic('a'.repeat(102)).event_type).toBeUndefined();
});
