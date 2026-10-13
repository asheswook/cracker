import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { ErrorCode, McpError, ToolListChangedNotificationSchema, type Tool } from '@modelcontextprotocol/sdk/types.js';
import { httpTransport } from './mcp-http';
import { staleMcpConnection } from './mcp-call';

function fingerprint(tools: readonly Tool[]): string {
  const canonical = (value: unknown): unknown => Array.isArray(value) ? value.map(canonical) :
    value !== null && typeof value === 'object' ? Object.fromEntries(Object.entries(value).sort(([a],[b])=>a.localeCompare(b)).map(([key,item])=>[key,canonical(item)])) : value;
  return JSON.stringify(canonical([...tools].sort((a,b)=>a.name.localeCompare(b.name))));
}

/** Remote generations retain leases until existing requests finish; only future calls move. */
export class McpHttpSession {
  private current: Client;
  private stale = false;
  private closed = false;
  private pending: Promise<Client> | undefined;
  private catalogue: string | undefined;
  private readonly lifetime = new AbortController();
  private readonly leases = new Map<Client,number>();
  constructor(client: Client, private readonly target: {readonly url: string; readonly headers: Readonly<Record<string,string>>; readonly health:(connected:boolean)=>void; readonly changed:()=>Promise<void>; readonly observe:(event:{readonly event:'mcp.connection.reconnect.start'|'mcp.connection.reconnect.success'|'mcp.connection.reconnect.error';readonly duration_ms:number;readonly active_generations:number})=>void}) {
    this.current = client; this.leases.set(client,0);this.bind(client);
  }
  private bind(client:Client):void {
    client.onclose=()=>{if(!this.closed&&client===this.current){this.stale=true;this.target.health(false);}};
    client.onerror=error=>{if(!this.closed&&client===this.current){if(staleMcpConnection(error))this.stale=true;this.target.health(false);}};
    client.setNotificationHandler(ToolListChangedNotificationSchema,async()=>{if(!this.closed&&client===this.current)await this.target.changed();});
  }
  pin(tools: readonly Tool[]): void { this.catalogue = fingerprint(tools); }
  private async fresh(): Promise<Client> {
    if(this.leases.size>=8)throw new McpError(ErrorCode.ConnectionClosed,'MCP reconnect generation limit reached');
    const started=performance.now();
    const observe=(event:'mcp.connection.reconnect.start'|'mcp.connection.reconnect.success'|'mcp.connection.reconnect.error')=>this.target.observe({event,duration_ms:Math.round(performance.now()-started),active_generations:this.leases.size});
    const signal=AbortSignal.any([this.lifetime.signal,AbortSignal.timeout(8000)]);
    const client = new Client({name:'autonomous-assistant',version:'0.1.0'});
    this.leases.set(client,0);this.bind(client);observe('mcp.connection.reconnect.start');
    try {
      await client.connect(httpTransport(new URL(this.target.url),{...this.target.headers}),{timeout:8000,signal});
      const tools: Tool[] = [], cursors = new Set<string>();
      let cursor: string | undefined;let pages=0;
      do {
        if(++pages>100)throw new McpError(ErrorCode.InvalidRequest,'MCP reconnect catalogue exceeds limits');
        const page = await client.listTools(cursor ? {cursor} : {},{timeout:8000,signal});
        tools.push(...page.tools); cursor=page.nextCursor;
        if(tools.length>100 || (cursor && cursors.has(cursor)))throw new McpError(ErrorCode.InvalidRequest,'MCP reconnect catalogue exceeds limits');
        if(cursor)cursors.add(cursor);
      } while(cursor);
      if(this.catalogue!==fingerprint(tools))throw new McpError(ErrorCode.InvalidRequest,'MCP reconnect catalogue changed; explicit synchronization required');
      this.lifetime.signal.throwIfAborted();
      const old=this.current;
      if(this.leases.get(old)===0){this.leases.delete(old);await old.close();}
      this.lifetime.signal.throwIfAborted();
      this.current=client; this.stale=false;this.target.health(true);observe('mcp.connection.reconnect.success');
      return client;
    } catch(error) { this.leases.delete(client);await client.close();observe('mcp.connection.reconnect.error');throw error; }
  }
  private async ready(signal: AbortSignal): Promise<Client> {
    signal.throwIfAborted();
    if(this.closed)throw new McpError(ErrorCode.ConnectionClosed,'MCP session removed');
    if(!this.stale)return this.current;
    const pending=this.pending??=this.fresh().finally(()=>{this.pending=undefined;});
    let abort:()=>void=()=>{};
    try {
      return await Promise.race([pending,new Promise<never>((_,reject)=>{
        abort=()=>reject(signal.reason);signal.addEventListener('abort',abort,{once:true});
        if(signal.aborted)abort();
      })]);
    } finally {signal.removeEventListener('abort',abort);}
  }
  async run<T>(signal: AbortSignal, work: (client: Client)=>Promise<T>): Promise<T> {
    const client=await this.ready(signal);signal.throwIfAborted();
    if(this.closed)throw new McpError(ErrorCode.ConnectionClosed,'MCP session removed');
    this.leases.set(client,(this.leases.get(client)??0)+1);
    try {const result=await work(client);if(!this.closed&&client===this.current&&!this.stale)this.target.health(true);return result;}
    catch(error){if(!signal.aborted&&client===this.current&&staleMcpConnection(error)){this.stale=true;this.target.health(false);}throw error;}
    finally {
      const remaining=(this.leases.get(client)??1)-1;
      if(this.closed)this.leases.delete(client);else this.leases.set(client,remaining);
      if(client!==this.current&&remaining===0){this.leases.delete(client);await client.close();}
    }
  }
  async close(): Promise<void> {
    this.closed=true;this.lifetime.abort();
    const results=await Promise.allSettled([...this.leases.keys()].map(client=>client.close()));
    if(this.pending)await Promise.allSettled([this.pending]);
    this.leases.clear();
    const failures=results.flatMap(result=>result.status==='rejected'?[result.reason]:[]);
    if(failures.length)throw new AggregateError(failures,'MCP session cleanup failed');
  }
}
