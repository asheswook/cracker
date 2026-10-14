import { setTimeout as delay } from 'node:timers/promises';
import { transientControlError } from './control-failure-policy';

// Only repeat side-effect-free reads or idempotent journal delivery, never tools
// or an inference/run. Abort stops the waiter, not another run's shared writer.
export async function controlBoundary<T>(signal:AbortSignal,operation:()=>Promise<T>,retry?:(attempt:number,delayMs:number)=>void):Promise<T>{
  for(let attempt=0;;attempt++){
    signal.throwIfAborted();const aborted=Promise.withResolvers<never>(),cancel=()=>aborted.reject(signal.reason);
    signal.addEventListener('abort',cancel,{once:true});
    try{
      const result=await Promise.race([Promise.resolve().then(()=>{signal.throwIfAborted();return operation();}),aborted.promise]);
      signal.throwIfAborted();return result;
    }catch(error){
      signal.throwIfAborted();if(!transientControlError(error))throw error;
    }finally{signal.removeEventListener('abort',cancel);}
    const wait=Math.min(5000,250*2**Math.min(attempt,5));retry?.(attempt+1,wait);
    await delay(wait,undefined,{signal});
  }
}
