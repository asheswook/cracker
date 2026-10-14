import { HTTPError, TimeoutError } from 'ky';
import { z } from 'zod';
import { controlErrorCode } from './control-diagnostic';

const NetworkCode=z.enum(['ECONNRESET','ECONNREFUSED','ETIMEDOUT','EPIPE','ENETUNREACH','EHOSTUNREACH','EAI_AGAIN','ENOTFOUND','ConnectionRefused','ConnectionClosed','SocketClosed']);
export function transientControlError(error:unknown):boolean{
  if(error instanceof HTTPError)return error.response.status>=500||[408,425,429].includes(error.response.status);
  if(error instanceof TimeoutError)return true;
  return error instanceof Error&&(('code' in error&&NetworkCode.safeParse(error.code).success)||error instanceof TypeError&&/fetch failed|failed to fetch|network error/i.test(error.message));
}
export async function controlFailureAction(error:Error,barrierFailed=false):Promise<'retry'|'disconnect'|'exit'>{
  if(error instanceof HTTPError&&([401,403].includes(error.response.status)||await controlErrorCode(error)==='stale_session'))return 'exit';
  return !barrierFailed&&transientControlError(error)?'retry':'disconnect';
}
