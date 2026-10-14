import { expect, test } from 'bun:test';
import { mkdtemp, mkdir, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { z } from 'zod';
import { ToolExecutor, type ToolScope } from '../services/daemon/tools';
import { BuiltinBrowser } from '../services/daemon/builtin-browser';
import { BuiltinDesktop } from '../services/daemon/builtin-desktop';

const signal=()=>new AbortController().signal;
const scope=(runId:string,lane:'foreground'|'background'='foreground'):ToolScope=>({runId,lane});
class BrowserFixture extends BuiltinBrowser {
  calls=0;
  override has(name:string){return name.startsWith('browser_');}
  override async run(){this.calls++;return {text:'observed',images:[]};}
}

test('every built-in browser and desktop tool is denied without the calling run lease',async()=>{
  const tools=new ToolExecutor(),browser=new BrowserFixture();Object.defineProperty(tools,'browser',{value:browser});
  tools.desktopLease.acquire('bg','background');
  try{
    for(const name of ['computer','computer_exec','desktop_get_app_state','desktop_query','desktop_click','browser_snapshot','browser_tabs','browser_take_screenshot','browser_network_requests']){
      const result=await tools.run(name,'{}',signal(),scope('fg'));
      expect(JSON.parse(result.text)).toMatchObject({status:'desktop_busy',executed:false});
    }
    expect(browser.calls).toBe(0);
    const result=JSON.parse((await tools.run('wait_for_desktop','{"max_seconds":1}',signal(),scope('fg'))).text);
    expect(result).toMatchObject({granted:true});expect(result.instruction).toContain('Fresh observation');
    expect((await tools.run('browser_snapshot','{}',signal(),scope('fg'))).text).toBe('observed');expect(browser.calls).toBe(1);
  }finally{await tools.close();}
});

test('takeover revokes the lease and blocks observations and waits until return_control',async()=>{
  const tools=new ToolExecutor(),browser=new BrowserFixture();Object.defineProperty(tools,'browser',{value:browser});
  try{
    await tools.run('browser_snapshot','{}',signal(),scope('fg'));await tools.revokeDesktopInputs();tools.desktopInputsReleased();
    expect(tools.desktopLease.current()).toBeUndefined();
    expect(JSON.parse((await tools.run('browser_snapshot','{}',signal(),scope('fg'))).text).executed).toBe(false);
    expect(JSON.parse((await tools.run('wait_for_desktop','{"max_seconds":1}',signal(),scope('fg'))).text).granted).not.toBe(true);
    tools.setDesktopOwner('agent');await tools.run('browser_snapshot','{}',signal(),scope('bg','background'));expect(browser.calls).toBe(2);
  }finally{await tools.close();}
});

test('run-scoped shell cleanup and session IDs cannot affect another run; OUTPUT_DIR is isolated',async()=>{
  const root=await mkdtemp('/tmp/agent-par/.parallel-shell-'),tools=new ToolExecutor();
  const a={...scope('a'),workspace:join(root,'a')},b={...scope('b','background'),workspace:join(root,'b')};
  await mkdir(a.workspace);await mkdir(b.workspace);
  const session=z.object({session_id:z.uuid(),cwd:z.string()});
  const start=JSON.stringify({command:'read value; printf "%s:%s" "$OUTPUT_DIR" "$value"',cwd:null,yield_ms:0,max_output_chars:1000});
  try{
    const first=session.parse(JSON.parse((await tools.run('shell_start',start,signal(),a)).text));
    const second=session.parse(JSON.parse((await tools.run('shell_start',start,signal(),b)).text));
    expect(first.cwd).toBe(a.workspace);expect(second.cwd).toBe(b.workspace);
    expect(tools.hasPendingShellSessions('a')).toBe(true);expect(tools.hasPendingShellSessions('b')).toBe(true);
    const args=(action:string,input:string|null)=>JSON.stringify({session_id:second.session_id,action,input,yield_ms:100,max_output_chars:1000});
    await expect(tools.run('shell_session',args('poll',null),signal(),a)).rejects.toThrow('shell_session_unknown_or_expired');
    await tools.releaseRun('a');expect(tools.hasPendingShellSessions('a')).toBe(false);expect(tools.hasPendingShellSessions('b')).toBe(true);
    const result=JSON.parse((await tools.run('shell_session',args('input','alive\n'),signal(),b)).text);
    expect(result.output).toBe(`${b.workspace}:alive`);
  }finally{await tools.close();await rm(root,{recursive:true,force:true});}
});

test('run-end desktop cleanup cannot be preempted by a foreground waiter mid-reset',async()=>{
  const tools=new ToolExecutor(),entered=Promise.withResolvers<void>(),release=Promise.withResolvers<void>();
  Object.defineProperty(tools,'desktop',{value:{reset:async()=>{entered.resolve();await release.promise;},close:async()=>{return;}}});
  Object.defineProperty(tools,'desktopRun',{value:'bg',writable:true});tools.desktopLease.acquire('bg','background');
  const cleanup=tools.releaseRun('bg');await entered.promise;let granted=false;
  const waiting=tools.run('wait_for_desktop','{"max_seconds":1}',signal(),scope('fg')).then(result=>{granted=JSON.parse(result.text).granted===true;return result;});
  try{await Bun.sleep(10);expect(granted).toBe(false);release.resolve();await cleanup;await waiting;expect(granted).toBe(true);}
  finally{release.resolve();await tools.close();}
});

class ObservationDesktop extends BuiltinDesktop{
  calls:string[]=[];closed=0;
  override has(name:string){return name.startsWith('desktop_');}
  override async run(name:string){this.calls.push(name);return {text:JSON.stringify({isError:false}),images:name==='desktop_get_app_state'?['data:image/png;base64,Zg==']:[]};}
  override async close(){this.closed++;}
}
for(const mutation of ['desktop_click','desktop_type_text','desktop_press_key','desktop_scroll','desktop_set_value','desktop_drag','desktop_perform_secondary_action','computer','computer_exec','browser_click','browser_tabs'])test(`P1-4 ${mutation} cannot reuse an observation from an older lease generation`,async()=>{
  const tools=new ToolExecutor(),desktop=new ObservationDesktop(),browser=new BrowserFixture();
  Object.defineProperty(tools,'builtinDesktop',{value:desktop});Object.defineProperty(tools,'browser',{value:browser});
  let executions=0;Object.defineProperty(tools,'desktop',{value:{reset:async()=>{return;},close:async()=>{return;},run:async()=>{executions++;return {text:'{}',image:'data:image/png;base64,Zg=='};}}});
  try{
    await tools.run('desktop_get_app_state','{}',signal(),scope('fg'));tools.desktopLease.release('fg');
    await tools.run('desktop_get_app_state','{}',signal(),scope('bg','background'));tools.desktopLease.release('bg');
    const args=mutation==='computer'?JSON.stringify({action:'click',x:1,y:1,text:'',end_x:null,end_y:null}):mutation==='computer_exec'?JSON.stringify({code:'await desktop.click(1,1);',timeout_ms:1000}):mutation==='browser_tabs'?JSON.stringify({action:'close'}):'{}';
    const before=desktop.calls.length+browser.calls+executions;
    const stale=JSON.parse((await tools.run(mutation,args,signal(),scope('fg'))).text);
    expect(stale).toMatchObject({status:'desktop_observation_stale',executed:false});expect(desktop.calls.length+browser.calls+executions).toBe(before);
    expect(desktop.closed).toBeGreaterThanOrEqual(2);
    await tools.run('desktop_query','{}',signal(),scope('fg'));
    if(mutation!=='computer')expect((await tools.run(mutation,args,signal(),scope('fg'))).text).not.toContain('desktop_observation_stale');
  }finally{await tools.close();}
});

test('P1-4 screenshot-only computer_exec establishes fresh observation; an errored observation does not',async()=>{
  const tools=new ToolExecutor(),desktop=new ObservationDesktop();Object.defineProperty(tools,'builtinDesktop',{value:desktop});let executions=0;
  Object.defineProperty(tools,'desktop',{value:{reset:async()=>{return;},close:async()=>{return;},run:async()=>{executions++;return {text:'{}',image:'data:image/png;base64,Zg=='};}}});
  try{
    await tools.run('computer_exec','{"code":"return null;","timeout_ms":1000}',signal(),scope('fg'));
    await tools.run('computer_exec','{"code":"await desktop.click(1,1);","timeout_ms":1000}',signal(),scope('fg'));expect(executions).toBe(2);
    tools.desktopLease.release('fg');Object.defineProperty(desktop,'run',{value:async()=>({text:JSON.stringify({isError:true}),images:[]})});
    await tools.run('desktop_get_app_state','{}',signal(),scope('fg'));
    expect(JSON.parse((await tools.run('computer_exec','{"code":"await desktop.click(1,1);","timeout_ms":1000}',signal(),scope('fg'))).text).status).toBe('desktop_observation_stale');expect(executions).toBe(2);
  }finally{await tools.close();}
});

test('P1-4 a cancelled observation returning an image cannot authorize the next mutation',async()=>{
  const tools=new ToolExecutor(),desktop=new ObservationDesktop(),abort=new AbortController();
  Object.defineProperty(tools,'builtinDesktop',{value:desktop});
  Object.defineProperty(desktop,'run',{value:async()=>{abort.abort(new Error('Observation cancelled'));return {text:'{"isError":false}',images:['data:image/png;base64,Zg==']};}});
  try{
    await expect(tools.run('desktop_get_app_state','{}',abort.signal,scope('fg'))).rejects.toThrow('Observation cancelled');
    expect(JSON.parse((await tools.run('desktop_click','{}',signal(),scope('fg'))).text)).toMatchObject({status:'desktop_observation_stale',executed:false});
  }finally{await tools.close();}
});
