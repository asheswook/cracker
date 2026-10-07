import { test, expect } from "bun:test";
import { execute } from "../services/daemon/shell.ts";

test("shell receives OS variables and output directory but no daemon/provider secrets", async () => {
  // Given synthetic secrets only; no real credential is printed or asserted.
  const names = ["VM_TOKEN", "OPENAI_API_KEY", "DATABASE_URL", "CHATGPT_TOKEN_FILE", "EXTENSION_ENCRYPTION_KEY"] as const;
  const previous = Object.fromEntries(names.map(name => [name, process.env[name]]));
  for (const name of names) process.env[name] = `synthetic-${name}-must-remain-private`;
  try {
    // When the real child inspects key presence, not values.
    const result = await execute([process.execPath, "-e", "console.log(JSON.stringify({vm:process.env.VM_TOKEN!==undefined,api:process.env.OPENAI_API_KEY!==undefined,db:process.env.DATABASE_URL!==undefined,oauth:process.env.CHATGPT_TOKEN_FILE!==undefined,extensions:process.env.EXTENSION_ENCRYPTION_KEY!==undefined,path:!!process.env.PATH,output:process.env.OUTPUT_DIR}))"], new AbortController().signal, "/tmp");
    // Then
    const parsed = JSON.parse(result);
    expect(JSON.parse(parsed.output)).toEqual({ vm: false, api: false, db: false, oauth: false, extensions: false, path: true, output: "/tmp" });
  } finally { for (const name of names) { const value = previous[name]; if (value === undefined) delete process.env[name]; else process.env[name] = value; } }
});
test("accidental known-secret output is redacted before reaching the model", async () => {
  // Given
  const previous = process.env["VM_TOKEN"];
  process.env["VM_TOKEN"] = "synthetic-private-token-731";
  try {
    // When
    const result = await execute(["printf", "%s", "synthetic-private-token-731"], new AbortController().signal);
    // Then
    expect(JSON.parse(result)).toEqual({ exit_code: 0, output: "[REDACTED]" });
  } finally { if (previous === undefined) delete process.env["VM_TOKEN"]; else process.env["VM_TOKEN"] = previous; }
});
