import {test,expect} from 'bun:test';
import {runtimeFailure} from '../services/daemon/runtime.ts';
import {DesktopError} from '../services/daemon/desktop-protocol.ts';
test('failure diagnostic permits only fixed desktop codes, without messages, names or arbitrary properties',()=>{
 const run=crypto.randomUUID(),secret='synthetic-secret-must-not-log';
 const known=new DesktopError('desktop_busy');known.message=secret;known.name=secret;known.stack=secret;
 expect(runtimeFailure(run,known)).toEqual({event:'runtime.failure',run_id:run,type:'desktop',code:'desktop_busy'});
 for(const error of [new DesktopError(secret),new Error(secret),{code:'desktop_busy',message:secret},secret]){
  const diagnostic=runtimeFailure(run,error);
  expect(Object.keys(diagnostic).sort()).toEqual(['code','event','run_id','type']);
  expect(JSON.stringify(diagnostic)).not.toContain(secret);expect(JSON.stringify(diagnostic).length).toBeLessThan(180);
 }
 expect(runtimeFailure(run,new DesktopError(secret)).code).toBe('unknown_desktop_error');
 expect(runtimeFailure(run,{code:'desktop_busy'}).type).toBe('unexpected');
});
