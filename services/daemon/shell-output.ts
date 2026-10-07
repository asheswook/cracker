import { fileURLToPath } from "node:url";
const privateEnvironment = new Set(["VM_TOKEN", "OPENAI_API_KEY", "DATABASE_URL", "TEST_DATABASE_URL", "CHATGPT_TOKEN_FILE", "CHATGPT_ACCESS_TOKEN", "CHATGPT_REFRESH_TOKEN", "PROVISION_TOKEN", "CLIENT_TOKEN", "CONTROL_TOKEN", "CONTROL_CLIENT_TOKEN", "EXTENSION_ENCRYPTION_KEY"]);

export function shellEnvironment(workspace?: string): NodeJS.ProcessEnv {
  const environment = Object.fromEntries(Object.entries(process.env).filter(([name]) => !privateEnvironment.has(name)));
  if (workspace) environment["OUTPUT_DIR"] = workspace;
  return environment;
}

export function shellSecrets(): readonly string[] {
  return [...privateEnvironment].flatMap(name => { const value = process.env[name]; return value && value.length >= 8 ? [value] : []; }).sort((a, b) => b.length - a.length);
}

// Keep possible secret prefixes private until another chunk disambiguates them.
export class ShellRedactor {
  private pending = "";
  constructor(private readonly secrets: readonly string[]) {}
  push(text: string, final = false): string {
    this.pending += text;
    let output = "";
    while (this.pending) {
      const secret = this.secrets.find(value => this.pending.startsWith(value));
      if (secret) { output += "[REDACTED]"; this.pending = this.pending.slice(secret.length); continue; }
      if (!final && this.secrets.some(value => value.startsWith(this.pending))) break;
      output += this.pending[0]; this.pending = this.pending.slice(1);
    }
    return output;
  }
}

export function shellCommand(argv: readonly string[]): readonly [string, ...string[]] {
  const [program, ...args] = argv;
  if (!program) throw new TypeError("empty_command");
  return process.platform === "linux"
    ? ["python3", "-I", fileURLToPath(new URL("./shell-supervisor.py", import.meta.url)), String(process.pid), program, ...args]
    : [program, ...args];
}
