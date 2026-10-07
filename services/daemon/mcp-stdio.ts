import { fileURLToPath } from "node:url";
import { readdirSync } from "node:fs";
import { join } from "node:path";
import { getDefaultEnvironment, StdioClientTransport, type StdioServerParameters } from "@modelcontextprotocol/sdk/client/stdio.js";

class McpCommandNotFoundError extends Error {
  readonly code = "ENOENT";
  constructor() { super("MCP executable not found"); this.name = "McpCommandNotFoundError"; }
}

export function stdioEnvironment(parameters: StdioServerParameters, inherited = getDefaultEnvironment()): Record<string, string> {
  const env = { ...inherited, ...parameters.env };
  const options = { PATH: env["PATH"] ?? "/usr/bin:/bin", ...(parameters.cwd === undefined ? {} : { cwd: parameters.cwd }) };
  if (parameters.env?.["PATH"] !== undefined || Bun.which(parameters.command, options)) return env;
  const nvm = env["NVM_DIR"] ?? (env["HOME"] ? join(env["HOME"], ".nvm") : undefined);
  if (!nvm) return env;
  let versions: string[];
  try { versions = readdirSync(join(nvm, "versions/node")); }
  catch (error) {
    if (error instanceof Error && "code" in error && error.code === "ENOENT") return env;
    throw error;
  }
  for (const version of versions.filter(value => /^v\d+\.\d+\.\d+$/.test(value)).sort((a, b) => b.localeCompare(a, "en", { numeric: true }))) {
    const bin = join(nvm, "versions/node", version, "bin");
    if (!Bun.which("node", { PATH: bin }) || !Bun.which(parameters.command, { ...options, PATH: bin })) continue;
    // npx uses /usr/bin/env node, so command lookup and child PATH must agree.
    return { ...env, PATH: `${bin}:${options.PATH}` };
  }
  return env;
}

export function stdioTransport(parameters: StdioServerParameters): StdioClientTransport {
  if (process.platform !== "linux") return new StdioClientTransport(parameters);
  const env = stdioEnvironment(parameters);
  const command = Bun.which(parameters.command, { PATH: env["PATH"] ?? "/usr/bin:/bin", ...(parameters.cwd === undefined ? {} : { cwd: parameters.cwd }) });
  if (!command) throw new McpCommandNotFoundError();
  // The supervisor owns a separate session and kills its group on child or daemon exit.
  return new StdioClientTransport({ ...parameters, env, command: "/usr/bin/python3", args: ["-I", fileURLToPath(new URL("./shell-supervisor.py", import.meta.url)), String(process.pid), command, ...parameters.args ?? []] });
}
