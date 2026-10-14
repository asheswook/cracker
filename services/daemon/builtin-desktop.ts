import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { z } from "zod";
import { stdioTransport } from "./mcp-stdio";
import type { Tool } from "../../packages/provider";

const execute = promisify(execFile);
export function parseAtSpiBus(output: string): string | undefined {
  return /^AT_SPI_BUS\([^\r\n)]+\)\s*=\s*"([^"\r\n]+)"\s*$/m.exec(output)?.[1];
}
export function desktopReadOnly(name: string): boolean {
  return ["desktop_list_apps", "desktop_get_app_state", "desktop_query"].includes(name);
}
export function desktopTool(tool: { name: string; description?: string | undefined; inputSchema: unknown }): Extract<Tool, { type: "function" }> {
  const guidance = tool.name === "get_app_state" ? "Returns the window's accessibility tree with element indexes plus a screenshot; prefer element_index targets over coordinates. Pass app exactly as desktop_list_apps names it (e.g. \"Google Chrome\"), never a guessed binary name. "
    : tool.name === "list_apps" ? "Call first to learn exact app names for the other desktop_ tools. " : "";
  return { type: "function", name: `desktop_${tool.name}`, description: guidance + (tool.description ?? tool.name), strict: false,
    parameters: z.record(z.string(), z.unknown()).parse(tool.inputSchema) };
}
export function desktopResult(value: unknown) {
  const result = z.object({ content: z.unknown(), isError: z.unknown().optional() }).parse(value);
  const content = z.array(z.object({ type: z.string(), text: z.string().optional(), data: z.string().optional(), mimeType: z.string().optional() })).parse(result.content);
  const text = JSON.stringify({ isError: result.isError === true, content: content.filter(part => part.type !== "image") });
  const images = content.flatMap(part => part.type === "image" && part.data && part.mimeType ? [`data:${part.mimeType};base64,${part.data}`] : []);
  return { text: text.length > 100000 ? JSON.stringify({ truncated: true, output: text.slice(0,100000) }) : text, images };
}
async function environment() {
  const env = Object.fromEntries(["DISPLAY", "XAUTHORITY", "DBUS_SESSION_BUS_ADDRESS", "PATH", "HOME"].flatMap(name => {
    const value = process.env[name]; return value === undefined ? [] : [[name, value]];
  }));
  let address = process.env["AT_SPI_BUS_ADDRESS"];
  if (!address) {
    try { address = parseAtSpiBus((await execute("xprop", ["-root", "AT_SPI_BUS"], { env, timeout: 3000, maxBuffer: 4096 })).stdout); }
    catch (error) { console.warn(JSON.stringify({ event: "desktop.at_spi_bus_lookup_failed", error: error instanceof Error ? error.message : String(error) })); }
  }
  if (address) env["AT_SPI_BUS_ADDRESS"] = address;
  else console.warn(JSON.stringify({ event: "desktop.at_spi_bus_unavailable", level: "warning" }));
  return env;
}
export class BuiltinDesktop {
  private client: Client | undefined;
  readonly definitions: Tool[] = [];
  private async connect() {
    if (this.client) return this.client;
    const client = new Client({ name: "assistant-builtin-desktop", version: "1.0.0" });
    const transport = stdioTransport({ command: process.env["OPEN_COMPUTER_USE_BIN"] || "open-computer-use", args: ["mcp"], env: await environment(), stderr: "inherit" });
    client.onclose = () => { if (this.client === client) this.client = undefined; };
    try { await client.connect(transport, { timeout: 10000 }); }
    catch (error) { await client.close(); throw error; }
    this.client = client;
    return client;
  }
  async initialize() {
    const listed = await (await this.connect()).listTools({}, { timeout: 10000 });
    this.definitions.splice(0, this.definitions.length, ...listed.tools.map(desktopTool));
  }
  has(name: string) { return this.definitions.some(tool => tool.type === "function" && tool.name === name); }
  async run(name: string, args: string, signal: AbortSignal) {
    signal.throwIfAborted();
    const client = await this.connect();
    try {
      return desktopResult(await client.callTool({ name: name.slice("desktop_".length), arguments: z.record(z.string(), z.unknown()).parse(JSON.parse(args)) }, undefined, { signal, timeout: 45000 }));
    } catch (error) { await this.close(); throw error; }
  }
  async close() { const previous = this.client; this.client = undefined; await previous?.close(); }
  async invalidateReferences(){await this.close();}
}
