import { expect, test } from 'bun:test';
import { ComputerControl } from '../services/daemon/computer-control';
import { ToolExecutor } from '../services/daemon/tools';

test('user desktop ownership rejects input before any external operation', async () => {
  // Given a user-owned desktop.
  const control = new ComputerControl(); control.setOwner('user');
  let called = false;
  // When an input action is attempted.
  const result = await control.run(true, new AbortController().signal, async () => { called = true; return {text:'clicked'}; });
  // Then no action ran and the caller receives an actionable result.
  expect(called).toBe(false);
  expect(JSON.parse(result.text)).toMatchObject({status:'computer_control_required',executed:false});
});

test('taking input control interrupts only the desktop operation and preserves the parent signal', async () => {
  // Given a live input operation and an independent parent execution signal.
  const control = new ComputerControl(), parent = new AbortController(), started = Promise.withResolvers<void>();
  const work = control.run(true, parent.signal, signal => new Promise((resolve,reject) => {
    started.resolve(); signal.addEventListener('abort', () => reject(signal.reason), {once:true});
  }));
  await started.promise;
  // When desktop ownership is revoked and inputs have been released.
  await control.revoke(); control.released();
  // Then desktop uncertainty is reported without aborting inference or shell work.
  expect(JSON.parse((await work).text)).toMatchObject({status:'computer_action_interrupted',effects_may_have_occurred:true});
  expect(parent.signal.aborted).toBe(false);
  expect(await control.run(false, parent.signal, async () => ({text:'read-only screenshot'}))).toEqual({text:'read-only screenshot'});
});

test('ownership transfer fences reads until release and permits explicit subsequent input ownership', async () => {
  // Given a desktop transfer awaiting the release barrier.
  const control = new ComputerControl(), signal = new AbortController().signal;
  await control.revoke();
  // When observation and input are attempted before the barrier, then after explicit return.
  expect(JSON.parse((await control.run(false,signal,async()=>({text:'unsafe read'}))).text).status).toBe('computer_control_changing');
  control.released(); control.setOwner('agent');
  // Then an explicitly returned desktop accepts input.
  expect(await control.run(true,signal,async()=>({text:'safe click'}))).toEqual({text:'safe click'});
});

test('real shell and filesystem operations remain usable while desktop input is denied', async () => {
  // Given the real tool executor on a user-owned desktop.
  const tools = new ToolExecutor(); tools.setDesktopOwner('user');
  try {
    // When shell computation and desktop input are requested.
    const shell = await tools.run('shell',JSON.stringify({command:'python3 -c "print(6 * 7)"'}),new AbortController().signal);
    const desktop = await tools.run('computer',JSON.stringify({action:'click',x:10,y:10}),new AbortController().signal);
    // Then computation succeeds while desktop input has no external effect.
    expect(shell.text).toContain('42');
    expect(JSON.parse(desktop.text)).toMatchObject({status:'computer_control_required',executed:false});
  } finally { await tools.close(); }
});
