import { mcpUrlRedactions } from "./mcp-url.ts";
import { McpConfig } from "../../packages/extensions/schema.ts";
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

export const toolDefinitions: Tool[] = [
  { type: "function", name: "shell", description: "Run bash in the dedicated Linux VM on the same filesystem as the desktop. Read/search/edit files, write and run Python for data, image or document processing, execute scripts and tests. Use python3 to run Python scripts. OUTPUT_DIR is the task output directory for publish_artifact. Blocks until exit; use shell_start for long or interactive commands. Broad autonomy; effects are journaled.", strict: true, parameters: { type: "object", properties: { command: { type: "string" } }, required: ["command"], additionalProperties: false } },
  { type: "function", name: "shell_start", description: "Start a command in this Linux VM, sharing the desktop filesystem. Returns promptly with a session ID; poll until exited. cwd is absolute or relative to OUTPUT_DIR (null uses OUTPUT_DIR). Pipes, not a TTY; use bash for a persistent shell and send newline-terminated commands. Sessions expire at task end/restart. Output is bounded: check remaining_output_chars and dropped_output_chars; redirect large logs to a file. Close unused sessions.", strict: true, parameters: { type: "object", properties: { command: { type: "string" }, cwd: { type: ["string", "null"] }, yield_ms: { type: "integer", minimum: 0, maximum: 10000 }, max_output_chars: { type: "integer", minimum: 1, maximum: 100000 } }, required: ["command", "cwd", "yield_ms", "max_output_chars"], additionalProperties: false } },
  { type: "function", name: "shell_session", description: "Read the next output chunk, send stdin, interrupt (SIGINT), or close (terminate process group) a task-scoped shell session. input requires text including newlines when needed; otherwise null. Poll until exited and remaining_output_chars is zero. close discards unread output beyond this result. Never rerun an uncertain command to recover a lost session.", strict: true, parameters: { type: "object", properties: { session_id: { type: "string" }, action: { type: "string", enum: ["poll", "input", "interrupt", "close"] }, input: { type: ["string", "null"] }, yield_ms: { type: "integer", minimum: 0, maximum: 10000 }, max_output_chars: { type: "integer", minimum: 1, maximum: 100000 } }, required: ["session_id", "action", "input", "yield_ms", "max_output_chars"], additionalProperties: false } },
  computerExecTool, computerTool
];

export type ToolResult = { readonly text: string; readonly image?: string; readonly images?: readonly string[] };
export class ToolExecutor {
  private browser: BuiltinBrowser | undefined;
  async enableBuiltinBrowser(): Promise<void> {
    const browser = new BuiltinBrowser();
    await browser.initialize(); this.browser = browser;
    this.definitions.push(...browser.definitions);
  }
  private readonly shells = new ShellSessions();
  async resetShellSessions(): Promise<void> { await this.shells.close(); }
  hasPendingShellSessions(): boolean { return this.shells.hasPending(); }
  private readonly desktop = new PersistentDesktop();
  async releaseDesktopInputs():Promise<void>{await this.browser?.close();await this.desktop.releaseInputs();}
  async resetDesktop(workspace?:string):Promise<void>{await this.desktop.reset(workspace);}
  private readonly connections = new Map<Client, string>();
  private readonly clients = new Map<string, { readonly client: Client; readonly name: string; readonly server: string; readonly readOnly:boolean }>();
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
  async addMcp(name:string,config:z.infer<typeof McpConfig>,secrets:Readonly<Record<string,string>>):Promise<number> {
    await this.removeMcp(name);
    const client=new Client({name:"autonomous-assistant",version:"0.1.0"});
    this.connections.set(client,name);this.secrets.set(client,[...Object.values(secrets), ...(config.transport === "http" ? mcpUrlRedactions(config.url) : [])].filter(Boolean));this.health.set(name,false);
    client.onclose=()=>{if(this.connections.has(client)){this.health.set(name,false);this.removeDefinitions(client);}};
    client.onerror=()=>{if(this.connections.has(client)){this.health.set(name,false);this.removeDefinitions(client);}};
    try {
      switch(config.transport){
        case "stdio":await client.connect(stdioTransport({command:config.command,args:config.args,env:secrets,stderr:"ignore"}),{timeout:8000});break;
        case "http":await client.connect(httpTransport(new URL(config.url),secrets),{timeout:8000});break;
        default:assertNever(config);
      }
      client.setNotificationHandler(ToolListChangedNotificationSchema,async()=>{
        try{await this.refresh(client,name);}catch(error){if(!(error instanceof Error))throw error;if(this.connections.has(client)){this.health.set(name,false);this.removeDefinitions(client);}}
      });
      await this.refresh(client,name);this.health.set(name,true);return this.mcpStatus(name).tool_count;
    }catch(error){await this.removeMcp(name);throw error;}
  }
  private removeDefinitions(client:Client):void {
    for(const [name,entry] of this.clients){if(entry.client!==client)continue;this.clients.delete(name);const index=this.definitions.findIndex(tool=>tool.type==="function"&&tool.name===name);if(index>=0)this.definitions.splice(index,1);}
  }
  async removeMcp(name:string):Promise<void>{
    for(const [client,server] of this.connections){if(server!==name)continue;this.connections.delete(client);this.removeDefinitions(client);this.secrets.delete(client);await client.close();}
    this.health.delete(name);
  }
  mcpStatus(name:string):{connected:boolean;tool_count:number}{return {connected:this.health.get(name)===true,tool_count:[...this.clients.values()].filter(entry=>entry.server===name).length};}
  async pingMcp(name:string):Promise<void>{for(const [client,server] of this.connections)if(server===name)await client.ping({timeout:5000});}
  private redact(value:unknown,client:Client):unknown{
    if(typeof value==="string"){let text=value;for(const secret of this.secrets.get(client)??[])text=text.split(secret).join("[REDACTED]");return text;}
    if(Array.isArray(value))return value.map(item=>this.redact(item,client));
    if(value!==null&&typeof value==="object")return Object.fromEntries(Object.entries(value).map(([key,item])=>[z.string().parse(this.redact(key,client)),this.redact(item,client)]));
    return value;
  }
  private async refresh(client: Client, server: string): Promise<void> {
    let page = await client.listTools({}, {timeout:8000});
    const listed = [...page.tools], cursors = new Set<string>();
    while (page.nextCursor) {
      if (cursors.has(page.nextCursor)) throw new ShellError("mcp_pagination_cycle");
      cursors.add(page.nextCursor);
      if(listed.length>100)throw new ShellError("mcp_tool_limit");
      page = await client.listTools({ cursor: page.nextCursor }, {timeout:8000});
      listed.push(...page.tools);
    }
    this.removeDefinitions(client);
    if(!this.connections.has(client))return;
    if(this.definitions.length+listed.length>100)throw new ShellError("mcp_tool_limit");
    for (const tool of listed) {
      if(JSON.stringify(tool.inputSchema).length>65536)throw new ShellError("mcp_schema_limit");
      const suffix = Bun.hash(tool.name).toString(16);
      const name = `mcp_${server}_${z.string().parse(this.redact(tool.name,client)).replace(/[^a-zA-Z0-9_]/g, "_").slice(0, 20)}_${suffix}`;
      if (this.clients.has(name)) throw new ShellError("mcp_tool_name_collision");
      this.clients.set(name, { client, name: tool.name, server, readOnly:tool.annotations?.readOnlyHint===true });
      this.definitions.push({ type: "function", name, description: z.string().parse(this.redact(tool.description ?? tool.name,client)).slice(0,4000), strict: false, parameters: z.record(z.string(),z.unknown()).parse(this.redact(tool.inputSchema,client)) });
    }
  }
  async refreshAll(): Promise<void> { for (const [client, server] of this.connections) await this.refresh(client, server); }
  async close(): Promise<void> {
    const closed=await Promise.allSettled([this.browser?.close(),this.resetShellSessions(),this.desktop.close(),...[...this.connections.values()].map(name=>this.removeMcp(name))]);
    const failed=closed.flatMap(result=>result.status==="rejected"?[result.reason]:[]);
    if(failed.length)throw new AggregateError(failed,"Tool cleanup failed");
  }
  async run(name: string, args: string, signal: AbortSignal): Promise<ToolResult> {
    signal.throwIfAborted();
    if (this.browser?.has(name)) return this.browser.run(name,args,signal);
    switch (name) {
      case "shell": return { text: await execute(["bash", "-lc", z.object({ command: z.string() }).parse(JSON.parse(args)).command], signal, this.workspace) };
      case "shell_start": return { text: await this.shells.start(args, { workspace: this.workspace, signal }) };
      case "shell_session": return { text: await this.shells.run(args, signal) };
      case "computer": try { return await runComputer(args,signal); } finally { await this.browser?.invalidateReferences(); }
      case "computer_exec": try { return await this.desktop.run(args,signal); } finally { await this.browser?.invalidateReferences(); }
      default: {
        const target = this.clients.get(name);
        if (!target) throw new ShellError("unknown_tool");
        const result = await target.client.callTool({ name: target.name, arguments: z.record(z.string(), z.unknown()).parse(JSON.parse(args)) }, undefined, { signal, timeout: 120000 });
        const text=JSON.stringify(this.redact(result,target.client));
        return { text: text.length<=100000?text:JSON.stringify({truncated:true,output:text.slice(0,100000)}) };
      }
    }
  }
}
function assertNever(value: never): never { throw new ShellError(`invalid_action:${String(value)}`); }
