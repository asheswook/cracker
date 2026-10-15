import { mcpUrlRedactions } from "./mcp-url.ts";
import { McpConfig, type ServerCategory } from "../../packages/extensions/schema.ts";
import { z } from "zod";
import { PersistentDesktop, computerExecTool } from "./desktop-session.ts";
import { computerTool, runComputer } from "./computer.ts";
import type { Tool } from "../../packages/provider/index.ts";
import { ShellSessions } from "./shell-session.ts";
import { execute, ShellError } from "./shell.ts";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { stdioTransport } from "./mcp-stdio.ts";
import { httpTransport } from "./mcp-http.ts";
import { ToolListChangedNotificationSchema } from "@modelcontextprotocol/sdk/types.js";
import { BuiltinBrowser } from "./builtin-browser";
import { BuiltinDesktop, desktopReadOnly } from "./builtin-desktop";
import { ComputerControl } from './computer-control';
import { callMcp } from './mcp-call';
import { McpHttpSession } from './mcp-session';
import { DesktopLease, desktopBusy, waitForDesktopTool, type Lane } from './desktop-lease';
export type ToolScope={readonly runId:string;readonly lane:Lane;readonly workspace?:string|undefined};

export const toolDefinitions: Tool[] = [
  { type: "function", name: "shell", description: "Run bash in the dedicated Linux VM on the same filesystem as the desktop. Read/search/edit files, write and run Python for data, image or document processing, execute scripts and tests. Use python3 to run Python scripts. OUTPUT_DIR is the task output directory for publish_artifact. Blocks until exit; use shell_start for long or interactive commands. Broad autonomy; effects are journaled.", strict: true, parameters: { type: "object", properties: { command: { type: "string" } }, required: ["command"], additionalProperties: false } },
  { type: "function", name: "shell_start", description: "Start a command in this Linux VM, sharing the desktop filesystem. Returns promptly with a session ID; poll until exited. cwd is absolute or relative to OUTPUT_DIR (null uses OUTPUT_DIR). Pipes, not a TTY; use bash for a persistent shell and send newline-terminated commands. Sessions expire at task end/restart. Output is bounded: check remaining_output_chars and dropped_output_chars; redirect large logs to a file. Close unused sessions.", strict: true, parameters: { type: "object", properties: { command: { type: "string" }, cwd: { type: ["string", "null"] }, yield_ms: { type: "integer", minimum: 0, maximum: 10000 }, max_output_chars: { type: "integer", minimum: 1, maximum: 100000 } }, required: ["command", "cwd", "yield_ms", "max_output_chars"], additionalProperties: false } },
  { type: "function", name: "shell_session", description: "Read the next output chunk, send stdin, interrupt (SIGINT), or close (terminate process group) a task-scoped shell session. input requires text including newlines when needed; otherwise null. Poll until exited and remaining_output_chars is zero. close discards unread output beyond this result. Never rerun an uncertain command to recover a lost session.", strict: true, parameters: { type: "object", properties: { session_id: { type: "string" }, action: { type: "string", enum: ["poll", "input", "interrupt", "close"] }, input: { type: ["string", "null"] }, yield_ms: { type: "integer", minimum: 0, maximum: 10000 }, max_output_chars: { type: "integer", minimum: 1, maximum: 100000 } }, required: ["session_id", "action", "input", "yield_ms", "max_output_chars"], additionalProperties: false } },
  computerExecTool, computerTool, waitForDesktopTool
];

export type ToolResult = { readonly text: string; readonly image?: string; readonly images?: readonly string[] };
export class ToolExecutor {
  private readonly control = new ComputerControl();
  readonly desktopLease = new DesktopLease();
  private desktopRun:string|undefined;
  private referenceGeneration=0;
  private desktopGeneration=0;
  private readonly observedGeneration=new Map<string,number>();
  setDesktopOwner(owner: 'agent' | 'user'): void { this.control.setOwner(owner);if(owner==='user')this.desktopLease.revokeAll();else this.desktopLease.allowGrants(); }
  async revokeDesktopInputs(): Promise<void> { this.desktopLease.revokeAll();await this.control.revoke(); }
  desktopInputsReleased(): void { this.control.released(); }
  private browser: BuiltinBrowser | undefined;
  private builtinDesktop: BuiltinDesktop | undefined;
  async enableBuiltinDesktop(): Promise<void> {
    const desktop = new BuiltinDesktop();
    try {
      await desktop.initialize(); this.builtinDesktop = desktop;
      this.definitions.push(...desktop.definitions);
    } catch (error) {
      console.error(JSON.stringify({ event: "desktop.connection_failed", error: error instanceof Error ? error.message : String(error) }));
      try { await desktop.close(); }
      catch (error) { console.error(JSON.stringify({ event: "desktop.cleanup_failed", error: error instanceof Error ? error.message : String(error) })); }
    }
  }
  async enableBuiltinBrowser(): Promise<void> {
    const browser = new BuiltinBrowser();
    await browser.initialize(); this.browser = browser;
    this.definitions.push(...browser.definitions);
  }
  private readonly shells = new ShellSessions();
  private readonly runShells=new Map<string,ShellSessions>();
  private shellScope(runId?:string):ShellSessions{if(!runId)return this.shells;let sessions=this.runShells.get(runId);if(!sessions){sessions=new ShellSessions();this.runShells.set(runId,sessions);}return sessions;}
  async resetShellSessions(runId?:string): Promise<void> {
    if(runId){const sessions=this.runShells.get(runId);await sessions?.close();this.runShells.delete(runId);return;}
    await Promise.all([this.shells.close(),...[...this.runShells.values()].map(sessions=>sessions.close())]);this.runShells.clear();
  }
  hasPendingShellSessions(runId?:string): boolean { return runId?this.runShells.get(runId)?.hasPending()??false:this.shells.hasPending(); }
  async releaseRun(runId:string):Promise<void>{
    await this.resetShellSessions(runId);
    if(this.desktopRun===runId&&this.desktopLease.current()?.runId===runId){
      this.desktopLease.begin(runId);
      try{await this.desktop.reset();this.desktopRun=undefined;}
      catch(error){this.desktopLease.revokeAll();throw error;}
      finally{this.desktopLease.end(runId);}
    }
    this.desktopLease.release(runId);
    this.observedGeneration.delete(runId);
  }
  private readonly desktop = new PersistentDesktop();
  async releaseDesktopInputs():Promise<void>{await this.browser?.close();await this.builtinDesktop?.close();await this.desktop.releaseInputs();}
  async resetDesktop(workspace?:string):Promise<void>{await this.desktop.reset(workspace);}
  private readonly remoteSessions = new Map<Client,McpHttpSession>();
  private readonly connections = new Map<Client, string>();
  private readonly categories = new Map<Client, ServerCategory|null>();
  private readonly clients = new Map<string, { readonly client: Client; readonly name: string; readonly server: string; readonly readOnly:boolean; readonly category:ServerCategory|null }>();
  toolCategory(name:string):ServerCategory|null{return this.clients.get(name)?.category??null;}
  parallelRead(name:string):boolean{return this.clients.get(name)?.readOnly===true;}
  isMcp(name:string):boolean{return this.clients.has(name);}
  private readonly secrets = new Map<Client, readonly string[]>();
  private readonly health = new Map<string, boolean>();
  private workspace: string | undefined;
  setWorkspace(path: string | undefined): void { this.workspace = path; this.browser?.setWorkspace(path); }
  readonly definitions = [...toolDefinitions];
  async connect(path: string): Promise<void> {
    const servers = z.array(z.discriminatedUnion("transport", [
      z.object({ transport: z.literal("stdio"), name: z.string().regex(/^[a-zA-Z0-9_]{1,20}$/), command: z.string(), args: z.array(z.string()) }),
      z.object({ transport: z.literal("http"), name: z.string().regex(/^[a-zA-Z0-9_]{1,20}$/), url: z.url(), headers: z.record(z.string(), z.string()).default({}) })
    ])).parse(await Bun.file(path).json());
    for (const server of servers) {
      const config=McpConfig.parse(server.transport === "stdio" ? {transport:server.transport,command:server.command,args:server.args} : {transport:server.transport,url:server.url});
      const name=`env_${Bun.hash(server.name).toString(16)}`;
      try{await this.addMcp(name,config,server.transport === "http" ? server.headers : {});}
      catch(error){if(!(error instanceof Error))throw error;process.stderr.write(JSON.stringify({event:"mcp.legacy.connection_failed",server:name})+"\n");}
    }
  }
  async addMcp(name:string,config:z.infer<typeof McpConfig>,secrets:Readonly<Record<string,string>>,category:ServerCategory|null=null):Promise<number> {
    await this.removeMcp(name);
    const client=new Client({name:"autonomous-assistant",version:"0.1.0"});
    this.categories.set(client,category);
    this.connections.set(client,name);this.secrets.set(client,[...Object.values(secrets), ...(config.transport === "http" ? mcpUrlRedactions(config.url) : [])].filter(Boolean));this.health.set(name,false);
    // Retain the offered catalogue during a run; idle reconciliation replaces it explicitly.
    client.onclose=()=>{if(this.connections.has(client))this.health.set(name,false);};
    client.onerror=()=>{if(this.connections.has(client))this.health.set(name,false);};
    const changed=async()=>{
      try{await this.refresh(client,name);}catch(error){if(!(error instanceof Error))throw error;if(this.connections.has(client)){this.health.set(name,false);this.removeDefinitions(client);}}
    };
    try {
      switch(config.transport){
        case "stdio":await client.connect(stdioTransport({command:config.command,args:config.args,env:secrets,stderr:"ignore"}),{timeout:8000});break;
        case "http":await client.connect(httpTransport(new URL(config.url),secrets),{timeout:8000});this.remoteSessions.set(client,new McpHttpSession(client,{url:config.url,headers:secrets,health:connected=>{if(this.connections.has(client))this.health.set(name,connected);},changed,observe:event=>console.warn(JSON.stringify({...event,server:name}))}));break;
        default:assertNever(config);
      }
      if(config.transport==="stdio")client.setNotificationHandler(ToolListChangedNotificationSchema,changed);
      await this.refresh(client,name);this.health.set(name,true);return this.mcpStatus(name).tool_count;
    }catch(error){await this.removeMcp(name);throw error;}
  }
  private removeDefinitions(client:Client):void {
    for(const [name,entry] of this.clients){if(entry.client!==client)continue;this.clients.delete(name);const index=this.definitions.findIndex(tool=>tool.type==="function"&&tool.name===name);if(index>=0)this.definitions.splice(index,1);}
  }
  async removeMcp(name:string):Promise<void>{
    for(const [client,server] of this.connections){if(server!==name)continue;this.connections.delete(client);this.removeDefinitions(client);this.categories.delete(client);this.secrets.delete(client);const session=this.remoteSessions.get(client);this.remoteSessions.delete(client);if(session)await session.close();else await client.close();}
    this.health.delete(name);
  }
  mcpStatus(name:string):{connected:boolean;tool_count:number}{return {connected:this.health.get(name)===true,tool_count:[...this.clients.values()].filter(entry=>entry.server===name).length};}
  async pingMcp(name:string):Promise<void>{for(const [client,server] of this.connections)if(server===name)await (this.remoteSessions.get(client)?.run(new AbortController().signal,current=>current.ping({timeout:5000}))??client.ping({timeout:5000}));}
  private redact(value:unknown,client:Client,secrets:readonly string[]=this.secrets.get(client)??[]):unknown{
    if(typeof value==="string"){let text=value;for(const secret of secrets)text=text.split(secret).join("[REDACTED]");return text;}
    if(Array.isArray(value))return value.map(item=>this.redact(item,client,secrets));
    if(value!==null&&typeof value==="object")return Object.fromEntries(Object.entries(value).map(([key,item])=>[z.string().parse(this.redact(key,client,secrets)),this.redact(item,client,secrets)]));
    return value;
  }
  private async refresh(client: Client, server: string): Promise<void> {
    const list=(cursor?:string)=>this.remoteSessions.get(client)?.run(new AbortController().signal,current=>current.listTools(cursor?{cursor}:{},{timeout:8000}))??client.listTools(cursor?{cursor}:{},{timeout:8000});
    let page = await list();
    const listed = [...page.tools], cursors = new Set<string>();
    while (page.nextCursor) {
      if (cursors.has(page.nextCursor)) throw new ShellError("mcp_pagination_cycle");
      cursors.add(page.nextCursor);
      if(listed.length>100)throw new ShellError("mcp_tool_limit");
      page = await list(page.nextCursor);
      listed.push(...page.tools);
    }
    this.remoteSessions.get(client)?.pin(listed);
    this.removeDefinitions(client);
    if(!this.connections.has(client))return;
    if(this.definitions.length+listed.length>100)throw new ShellError("mcp_tool_limit");
    for (const tool of listed) {
      if(JSON.stringify(tool.inputSchema).length>65536)throw new ShellError("mcp_schema_limit");
      const suffix = Bun.hash(tool.name).toString(16);
      const name = `mcp_${server}_${z.string().parse(this.redact(tool.name,client)).replace(/[^a-zA-Z0-9_]/g, "_").slice(0, 20)}_${suffix}`;
      if (this.clients.has(name)) throw new ShellError("mcp_tool_name_collision");
      this.clients.set(name, { client, name: tool.name, server, category:this.categories.get(client)??null, readOnly:tool.annotations?.readOnlyHint===true&&tool.annotations?.destructiveHint!==true });
      this.definitions.push({ type: "function", name, description: z.string().parse(this.redact(tool.description ?? tool.name,client)).slice(0,4000), strict: false, parameters: z.record(z.string(),z.unknown()).parse(this.redact(tool.inputSchema,client)) });
    }
  }
  async refreshAll(): Promise<void> { for (const [client, server] of this.connections) await this.refresh(client, server); }
  async close(): Promise<void> {
    this.desktopLease.revokeAll();this.observedGeneration.clear();
    const closed=await Promise.allSettled([this.browser?.close(),this.builtinDesktop?.close(),this.resetShellSessions(),this.desktop.close(),...[...this.connections.values()].map(name=>this.removeMcp(name))]);
    const failed=closed.flatMap(result=>result.status==="rejected"?[result.reason]:[]);
    if(failed.length)throw new AggregateError(failed,"Tool cleanup failed");
  }
  async run(name: string, args: string, signal: AbortSignal,scope?:ToolScope): Promise<ToolResult> {
    signal.throwIfAborted();
    const owner=scope??{runId:'legacy',lane:'foreground' as const,workspace:this.workspace};
    if(name==='wait_for_desktop'){
      const {max_seconds}=z.object({max_seconds:z.number().int().min(1).max(600)}).strict().parse(JSON.parse(args));
      const grant=await this.desktopLease.wait(owner.runId,owner.lane,max_seconds*1000,signal);signal.throwIfAborted();
      return grant.granted?{text:JSON.stringify({...grant,instruction:'Fresh observation required. Inspect the desktop or browser before acting; earlier references are stale.'})}:desktopBusy(grant);
    }
    const shared=name==='computer'||name==='computer_exec'||name.startsWith('desktop_')||name.startsWith('browser_');
    if(shared){
      const grant=this.desktopLease.acquire(owner.runId,owner.lane);if(!grant.granted)return desktopBusy(grant);
      this.desktopLease.begin(owner.runId);
      try{
        return await this.control.run(true,signal,async next=>{
          if(this.referenceGeneration!==grant.generation){
            await this.builtinDesktop?.invalidateReferences();await this.browser?.invalidateReferences();this.referenceGeneration=grant.generation;
          }
          if(desktopMutation(name,args)&&this.observedGeneration.get(owner.runId)!==grant.generation)
            return {text:JSON.stringify({status:'desktop_observation_stale',executed:false,instruction:'inspect again'})};
          if(name==='computer_exec'&&(this.desktopRun!==owner.runId||this.desktopGeneration!==grant.generation)){
            await this.desktop.reset(owner.workspace);this.desktopRun=owner.runId;this.desktopGeneration=grant.generation;
          }
          const result=await this.execute(name,args,next,owner);
          next.throwIfAborted();
          if(desktopObservation(name,args,result)&&this.desktopLease.owns(owner.runId,grant.generation))this.observedGeneration.set(owner.runId,grant.generation);
          return result;
        });
      }finally{this.desktopLease.end(owner.runId);}
    }
    return this.execute(name,args,signal,scope);
  }
  private async execute(name: string, args: string, signal: AbortSignal,scope?:ToolScope): Promise<ToolResult> {
    if (this.builtinDesktop?.has(name)) {
      try { return await this.builtinDesktop.run(name,args,signal); }
      finally { if (!desktopReadOnly(name)) await this.browser?.invalidateReferences(); }
    }
    if (this.browser?.has(name)) return this.browser.run(name,args,signal,scope?.workspace??this.workspace);
    switch (name) {
      case "shell": return { text: await execute(["bash", "-lc", z.object({ command: z.string() }).parse(JSON.parse(args)).command], signal, scope?.workspace??this.workspace) };
      case "shell_start": return { text: await this.shellScope(scope?.runId).start(args, { workspace: scope?.workspace??this.workspace, signal }) };
      case "shell_session": return { text: await this.shellScope(scope?.runId).run(args, signal) };
      case "computer": try { return await runComputer(args,signal); } finally { await this.browser?.invalidateReferences(); }
      case "computer_exec": try { return await this.desktop.run(args,signal); } finally { await this.browser?.invalidateReferences(); }
      default: {
        const target = this.clients.get(name);
        if (!target) throw new ShellError("unknown_tool");
        const redactions=this.secrets.get(target.client)??[];
        const argumentsValue=z.record(z.string(), z.unknown()).parse(JSON.parse(args));
        const response = await callMcp(async timeout => {
          const call=(client:Client)=>client.callTool({name:target.name,arguments:argumentsValue},undefined,{signal,timeout});
          const result=await (this.remoteSessions.get(target.client)?.run(signal,call)??call(target.client));
          if(this.connections.has(target.client)&&!this.remoteSessions.has(target.client))this.health.set(target.server,true);
          return result;
        },{signal,readOnly:target.readOnly,redact:message=>z.string().parse(this.redact(message,target.client,redactions)),
          observe:event=>console.warn(JSON.stringify({...event,server:target.server,tool_name:name}))});
        if(!response.ok)return {text:response.text};
        const text=JSON.stringify(this.redact(response.result,target.client,redactions));
        return { text: text.length<=100000?text:JSON.stringify({truncated:true,output:text.slice(0,100000)}) };
      }
    }
  }
}
function desktopMutation(name:string,args:string):boolean{
  if(name.startsWith('desktop_'))return !desktopReadOnly(name);
  if(name==='computer')return z.object({action:z.string()}).parse(JSON.parse(args)).action!=='screenshot';
  if(name==='computer_exec')return !/^\s*return\s+null\s*;?\s*$/.test(z.object({code:z.string()}).parse(JSON.parse(args)).code);
  if(['browser_snapshot','browser_take_screenshot','browser_console_messages','browser_network_requests','browser_network_request','browser_find'].includes(name))return false;
  if(name==='browser_tabs')return z.object({action:z.string()}).parse(JSON.parse(args)).action!=='list';
  return name.startsWith('browser_');
}
function desktopObservation(name:string,args:string,result:ToolResult):boolean{
  const image=(result.images?.length??0)>0||!!result.image;
  const observation=name==='desktop_get_app_state'||name==='desktop_query'||name==='browser_snapshot'
    ||name==='computer_exec'&&image||name==='computer'&&image&&z.object({action:z.string()}).parse(JSON.parse(args)).action==='screenshot';
  if(!observation)return false;
  try{
    const metadata=z.object({isError:z.boolean().optional(),executed:z.boolean().optional(),status:z.string().optional()}).safeParse(JSON.parse(result.text));
    return metadata.success&&metadata.data.isError!==true&&metadata.data.executed!==false&&metadata.data.status!=='computer_action_interrupted';
  }catch(error){if(!(error instanceof SyntaxError))throw error;return false;}
}
function assertNever(value: never): never { throw new ShellError(`invalid_action:${String(value)}`); }
