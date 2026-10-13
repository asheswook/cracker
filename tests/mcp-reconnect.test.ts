import { expect,test } from 'bun:test';
import { reconnectFixture } from './mcp-reconnect-fixture';
import { parseCallFailure } from './mcp-call-error-fixture';

test('expired HTTP MCP session establishes a fresh session for its single read-only retry',async()=>{
  // Given
  const f=await reconnectFixture(),catalogue=structuredClone(f.tools.definitions);f.expire();
  try {
    // When
    const result=await f.tools.run(f.read,'{}',new AbortController().signal);
    // Then
    expect(JSON.parse(result.text)).toEqual({content:[{type:'text',text:'result:2'}]});
    expect(f.initializes()).toBe(2);expect(f.calls.map(c=>c.session)).toEqual(['1','2']);expect(f.tools.definitions).toEqual(catalogue);
  } finally {await f.close();}
});

test('mutating failed call is not replayed but the next explicit call uses a fresh MCP session',async()=>{
  // Given
  const f=await reconnectFixture();f.expire();
  try {
    // When
    const failed=await f.tools.run(f.write,'{}',new AbortController().signal);
    // Then
    expect(parseCallFailure(failed.text)).toMatchObject({attempts:1,effect_uncertain:true});expect(f.initializes()).toBe(1);
    const next=await f.tools.run(f.read,'{}',new AbortController().signal);
    expect(JSON.parse(next.text)).toEqual({content:[{type:'text',text:'result:2'}]});expect(f.calls.filter(c=>c.name==='write')).toHaveLength(1);
  } finally {await f.close();}
});

test('parallel stale calls share one reconnect without cancelling a healthy old-generation call',async()=>{
  // Given
  const f=await reconnectFixture();
  try {
    const healthy=f.tools.run(f.read,JSON.stringify({mode:'hold'}),new AbortController().signal);await f.held.promise;f.expire();
    // When
    const results=await Promise.all([f.tools.run(f.read,'{}',new AbortController().signal),f.tools.run(f.read,'{}',new AbortController().signal)]);
    f.release.resolve();
    // Then
    expect(f.initializes()).toBe(2);for(const result of results)expect(JSON.parse(result.text).content[0].text).toBe('result:2');
    expect(JSON.parse((await healthy).text).content[0].text).toBe('result:1');
  } finally {await f.close();}
});

test('authentication rejection during reconnect does not loop or replay the tool',async()=>{
  // Given
  const f=await reconnectFixture();f.expire();f.deny();
  try {
    // When
    const result=await f.tools.run(f.read,'{}',new AbortController().signal);
    // Then
    expect(parseCallFailure(result.text)).toMatchObject({code:'authentication_failed',attempts:2,retryable:false});expect(f.initializes()).toBe(2);expect(f.calls).toHaveLength(1);
  } finally {await f.close();}
});

test('changed read-only annotation blocks replay and retains offered catalogue',async()=>{
  // Given
  const f=await reconnectFixture(),catalogue=structuredClone(f.tools.definitions);f.expire();f.change();
  try {
    // When
    const result=await f.tools.run(f.read,'{}',new AbortController().signal);
    // Then
    expect(parseCallFailure(result.text).attempts).toBe(2);expect(f.calls).toHaveLength(1);expect(f.tools.definitions).toEqual(catalogue);
  } finally {await f.close();}
});

test('cancelling one reconnect waiter does not abort another waiter sharing initialization',async()=>{
  // Given
  const f=await reconnectFixture();f.expire();f.holdInit();const controller=new AbortController();
  try {
    const cancelled=f.tools.run(f.read,'{}',controller.signal);await f.initializing.promise;
    const surviving=f.tools.run(f.read,'{}',new AbortController().signal);
    // When
    controller.abort(new DOMException('cancelled waiter','AbortError'));await expect(cancelled).rejects.toThrow('cancelled waiter');f.allowInitialize.resolve();
    // Then
    expect(JSON.parse((await surviving).text).content[0].text).toBe('result:2');expect(f.initializes()).toBe(2);
  } finally {await f.close();}
});

test('removing MCP during pending reconnect cannot resurrect its connection or definitions',async()=>{
  // Given
  const f=await reconnectFixture();f.expire();f.holdInit();
  try {
    const pending=f.tools.run(f.read,'{}',new AbortController().signal);await f.initializing.promise;
    // When
    const removing=f.tools.removeMcp('fixture');f.allowInitialize.resolve();await removing;await pending;
    // Then
    expect(f.tools.mcpStatus('fixture')).toEqual({connected:false,tool_count:0});expect(f.tools.definitions.some(t=>t.type==='function'&&t.name===f.read)).toBe(false);expect(f.calls).toHaveLength(1);
  } finally {await f.close();}
});

test('actual HTTP socket reset reconnects the MCP client before safe retry',async()=>{
  // Given a local TCP proxy dropping the first tools/call socket without a response.
  const f=await reconnectFixture(true);
  try {
    // When
    const result=await f.tools.run(f.read,'{}',new AbortController().signal);
    // Then
    expect(JSON.parse(result.text)).toEqual({content:[{type:'text',text:'result:2'}]});expect(f.initializes()).toBe(2);
    await f.tools.pingMcp('fixture');expect(f.tools.mcpStatus('fixture')).toEqual({connected:true,tool_count:2});
  } finally {await f.close();}
});

test('fresh MCP generation tracks ping health and tool-list notifications',async()=>{
  // Given a recovered session with the original stable catalogue.
  const f=await reconnectFixture();f.expire();
  try {
    await f.tools.run(f.read,'{}',new AbortController().signal);await f.tools.pingMcp('fixture');
    expect(f.tools.mcpStatus('fixture')).toEqual({connected:true,tool_count:2});
    // When the new session sends a real SSE tools/list_changed notification.
    f.notify();await f.tools.run(f.read,'{}',new AbortController().signal);
    const until=performance.now()+1000;
    while(!f.tools.definitions.some(t=>t.type==='function'&&t.name===f.read&&t.description==='updated catalogue')&&performance.now()<until)await Bun.sleep(5);
    // Then the existing notification refresh path runs on the new generation.
    expect(f.tools.definitions.some(t=>t.type==='function'&&t.name===f.read&&t.description==='updated catalogue')).toBe(true);
    expect(f.tools.mcpStatus('fixture')).toEqual({connected:true,tool_count:2});
  } finally {await f.close();}
});

test('retired generations are bounded and draining old requests releases reconnect capacity',async()=>{
  // Given a healthy request held open in each successive generation.
  const f=await reconnectFixture(),held:Promise<{readonly text:string}>[]=[];
  try {
    for(let generation=1;generation<=8;generation++){
      const expectedCalls=f.calls.length+1;
      held.push(f.tools.run(f.read,JSON.stringify({mode:'hold'}),new AbortController().signal));
      const until=performance.now()+1000;
      while(f.calls.length<expectedCalls&&performance.now()<until)await Bun.sleep(2);
      expect(f.calls.length).toBe(expectedCalls);f.expire();
      const result=await f.tools.run(f.read,'{}',new AbortController().signal);
      if(generation<8)expect(JSON.parse(result.text).isError).toBeUndefined();
      else expect(parseCallFailure(result.text).attempts).toBe(2);
    }
    expect(f.initializes()).toBe(8);
    // When all old requests drain.
    f.release.resolve();await Promise.all(held);
    const next=await f.tools.run(f.read,'{}',new AbortController().signal);
    // Then retired generations no longer consume reconnect capacity.
    expect(JSON.parse(next.text).content[0].text).toBe('result:9');expect(f.initializes()).toBe(9);
  } finally {f.release.resolve();await Promise.allSettled(held);await f.close();}
},15000);

test('empty unique catalogue pages cannot make reconnect unbounded',async()=>{
  // Given a server emitting endless fresh cursors only after its initial catalogue.
  const f=await reconnectFixture();f.expire();f.paginate();
  try {
    // When
    const result=await f.tools.run(f.read,'{}',new AbortController().signal);
    // Then
    expect(parseCallFailure(result.text).attempts).toBe(2);expect(f.listings()).toBe(101);expect(f.calls).toHaveLength(1);
  } finally {await f.close();}
});
