import { expect, test } from "bun:test";
import { chmod, mkdir, mkdtemp, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { stdioEnvironment } from "../services/daemon/mcp-stdio.ts";

test("MCP finds NVM npx and gives its shebang the matching Node without a per-server PATH", async () => {
  const home = await mkdtemp(join(tmpdir(), "mcp-nvm-"));
  try {
    const bin = join(home, ".nvm/versions/node/v24.21.0/bin");
    await mkdir(bin, { recursive: true });
    await symlink(process.execPath, join(bin, "node"));
    await writeFile(join(bin, "npx"), '#!/usr/bin/env node\nprocess.stdout.write("nvm-child-ok");\n');
    await chmod(join(bin, "npx"), 0o700);
    const env = stdioEnvironment({ command: "npx", env: { MCP_TEST_SECRET: "explicit" } }, { HOME: home, PATH: home });
    const executable = Bun.which("npx", { PATH: env["PATH"] ?? "" });
    expect(executable).toBe(join(bin, "npx"));
    if (!executable) throw new TypeError("NVM command not discovered");
    const child = Bun.spawn([executable], { env, stdout: "pipe", stderr: "pipe" });
    expect(await new Response(child.stdout).text()).toBe("nvm-child-ok");
    expect(await child.exited).toBe(0);
    expect(env["MCP_TEST_SECRET"]).toBe("explicit");
    expect(stdioEnvironment({ command: "npx", env: { PATH: home } }, { HOME: home, PATH: home })["PATH"]).toBe(home);
    await symlink(process.execPath, join(home, "npx"));
    expect(stdioEnvironment({ command: "npx" }, { HOME: home, PATH: home })["PATH"]).toBe(home);
  } finally { await rm(home, { recursive: true, force: true }); }
});

test("absent NVM leaves missing commands unchanged", () => {
  expect(stdioEnvironment({ command: "missing-mcp" }, { HOME: "/nonexistent-mcp-home", PATH: "/nonexistent-mcp-bin" })["PATH"]).toBe("/nonexistent-mcp-bin");
});
