import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { fileURLToPath } from "node:url";
import { existsSync } from "node:fs";
import { z } from "zod";
import { stdioTransport } from "./mcp-stdio";
import type { Tool } from "../../packages/provider";

export class BuiltinBrowser {
  constructor(private readonly endpoint = "http://127.0.0.1:9222") {}
  private client: Client | undefined;
  private workspace: string | undefined;
  private connectedWorkspace: string | undefined;
  readonly definitions: Tool[] = [];
  setWorkspace(path: string | undefined) { this.workspace = path; }
  private async connect() {
    if (this.client && this.connectedWorkspace !== this.workspace) await this.close();
    if (this.client) return this.client;
    const client = new Client({ name: "assistant-builtin-browser", version: "1.0.0" });
    const runtime = fileURLToPath(new URL("../../var/browser-runtime/bin/node", import.meta.url));
    const transport = stdioTransport({ command: existsSync(runtime) ? runtime : "node", args: [fileURLToPath(new URL("../../var/browser-worker.mjs", import.meta.url)), this.endpoint],
      env: { ...(process.env["PATH"] ? { PATH: process.env["PATH"] } : {}), ...(this.workspace ? { OUTPUT_DIR: this.workspace } : {}) }, stderr: "inherit" });
    client.onclose = () => { if (this.client === client) this.client = undefined; };
    await client.connect(transport, { timeout: 10000 });
    this.client = client;
    this.connectedWorkspace = this.workspace;
    return client;
  }
  async initialize() {
    const listed = await (await this.connect()).listTools();
    this.definitions.splice(0, this.definitions.length, ...listed.tools.map(tool => ({ type: "function" as const,
      name: tool.name, description: tool.description ?? tool.name, strict: false,
      parameters: z.record(z.string(), z.unknown()).parse(tool.inputSchema),
    })));
  }
  has(name: string) { return this.definitions.some(tool => tool.type === "function" && tool.name === name); }
  async invalidateReferences() {
    if (!this.client) return;
    try { await this.client.callTool({ name: "assistant_browser_invalidate", arguments: {} }, undefined, { timeout: 2000 }); }
    catch (error) { if (!(error instanceof Error)) throw error; await this.close(); }
  }
  async run(name: string, args: string, signal: AbortSignal) {
    signal.throwIfAborted();
    const client = await this.connect();
    try {
      const result = await client.callTool({ name, arguments: z.record(z.string(), z.unknown()).parse(JSON.parse(args)) }, undefined, { signal, timeout: 45000 });
      const content = z.array(z.object({ type: z.string(), text: z.string().optional(), data: z.string().optional(), mimeType: z.string().optional() })).parse(result.content);
      const text = JSON.stringify({ isError: result.isError === true, content: content.filter(part => part.type !== "image") });
      const images = content.flatMap(part => part.type === "image" && part.data && part.mimeType ? [`data:${part.mimeType};base64,${part.data}`] : []);
      return { text: text.length > 100000 ? JSON.stringify({ truncated: true, output: text.slice(0,100000) }) : text, images };
    } catch (error) {
      await this.close();
      throw error;
    }
  }
  async close() { const previous = this.client; this.client = undefined; await previous?.close(); }
}
