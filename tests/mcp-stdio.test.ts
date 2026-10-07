import { expect, test } from "bun:test";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { z } from "zod";
import { ToolExecutor } from "../services/daemon/tools.ts";
import { mcpConnectionFailure } from "../services/daemon/mcp-failure.ts";

const fixture = join(import.meta.dir, "mcp-stdio-fixture.ts");
const rootReceipt = z.object({ pid: z.number(), args: z.array(z.string()), explicit: z.string().optional(), ambient: z.string().optional() });
async function eventually(check: () => Promise<boolean>): Promise<void> {
  const deadline = Date.now() + 6000;
  while (!(await check())) {
    if (Date.now() > deadline) throw new Error("process state did not converge within 6 seconds");
    await Bun.sleep(20);
  }
}
async function live(pid: number): Promise<boolean> {
  try { return !(await readFile(`/proc/${pid}/stat`, "utf8")).split(") ")[1]?.startsWith("Z"); }
  catch (error) { if (error instanceof Error && "code" in error && error.code === "ENOENT") return false; throw error; }
}
async function pids(receipt: string): Promise<readonly number[]> {
  await eventually(async () => await Bun.file(`${receipt}.branch.leaf`).exists());
  return [rootReceipt.parse(await Bun.file(receipt).json()).pid, Number(await Bun.file(`${receipt}.branch`).text()), Number(await Bun.file(`${receipt}.branch.leaf`).text())];
}
async function cleanup(ids: readonly number[]): Promise<void> {
  for (const pid of ids) {
    try { process.kill(pid, "SIGKILL"); }
    catch (error) { if (!(error instanceof Error && "code" in error && error.code === "ESRCH")) throw error; }
  }
}

for (const action of ["disconnect", "wrapper-exit"] as const) {
  test.skipIf(process.platform !== "linux")(`stdio kills owned descendants on ${action} while a sibling remains callable`, async () => {
    // Given two independent real MCP process trees.
    const dir = await mkdtemp(join(tmpdir(), "mcp-process-")), tools = new ToolExecutor();
    let owned: readonly number[] = [], sibling: readonly number[] = [];
    try {
      for (const name of ["owned", "sibling"]) await tools.addMcp(name, { transport: "stdio", command: process.execPath, args: [fixture, "server", join(dir, name)] }, {});
      owned = await pids(join(dir, "owned")); sibling = await pids(join(dir, "sibling"));
      console.log(JSON.stringify({ scenario: action, owned, sibling, before: await Promise.all([...owned, ...sibling].map(live)) }));
      // When the connection closes or its wrapper dies unexpectedly.
      if (action === "disconnect") { await tools.removeMcp("owned"); await tools.removeMcp("owned"); }
      else { const [root] = owned; if (!root) throw new TypeError("missing root pid"); process.kill(root, "SIGKILL"); }
      // Then every owned process stops, but the other connection still works.
      await eventually(async () => (await Promise.all(owned.map(live))).every(value => !value));
      expect(await Promise.all(owned.map(live))).toEqual([false, false, false]);
      expect(await Promise.all(sibling.map(live))).toEqual([true, true, true]);
      await tools.pingMcp("sibling");
      await eventually(async () => !tools.mcpStatus("owned").connected);
      console.log(JSON.stringify({ scenario: action, ownedAfter: await Promise.all(owned.map(live)), siblingAfter: await Promise.all(sibling.map(live)), ownedStatus: tools.mcpStatus("owned") }));
    } finally { await cleanup([...owned, ...sibling]); await tools.close(); await rm(dir, { recursive: true, force: true }); }
  }, 20000);
}

test("missing stdio command retains command_not_found classification", async () => {
  // Given an unavailable executable.
  const tools = new ToolExecutor();
  try {
    // When connection is attempted.
    await tools.addMcp("missing", { transport: "stdio", command: "/nonexistent-mcp-cleanup-fixture", args: [] }, {});
    throw new Error("unexpected connection success");
  } catch (error) {
    // Then the public observation classification remains specific.
    if (!(error instanceof Error)) throw error;
    expect(mcpConnectionFailure(error)).toBe("command_not_found");
  } finally { await tools.close(); }
});

test.skipIf(process.platform !== "linux")("stdio preserves literal arguments and isolates ambient secrets with an explicit child PATH", async () => {
  // Given a command found only on the explicit PATH and shell metacharacters in argv.
  const dir = await mkdtemp(join(tmpdir(), "mcp-env-")), tools = new ToolExecutor();
  const { symlink } = await import("node:fs/promises");
  await symlink(process.execPath, join(dir, "fixture-runtime"));
  const receipt = join(dir, "receipt"), literal = "$(touch should-not-exist); ' quoted argument";
  const previous = process.env["MCP_FIXTURE_AMBIENT"];
  process.env["MCP_FIXTURE_AMBIENT"] = "synthetic-ambient-secret";
  let ids: readonly number[] = [];
  try {
    // When a real MCP launches through the configured environment.
    await tools.addMcp("env", { transport: "stdio", command: "fixture-runtime", args: [fixture, "server", receipt, literal] }, { PATH: dir, MCP_FIXTURE_EXPLICIT: "synthetic-explicit" });
    ids = await pids(receipt);
    // Then argv is literal, explicit env is present, ambient secret is absent.
    const observed = rootReceipt.parse(await Bun.file(receipt).json());
    expect(observed.args).toEqual([literal]);
    expect(observed.explicit).toBe("synthetic-explicit");
    expect(observed.ambient).toBeUndefined();
  } finally {
    if (previous === undefined) delete process.env["MCP_FIXTURE_AMBIENT"]; else process.env["MCP_FIXTURE_AMBIENT"] = previous;
    await tools.close(); await cleanup(ids); await rm(dir, { recursive: true, force: true });
  }
}, 15000);

test.skipIf(process.platform !== "linux")("stdio kills descendants when its owning daemon process is killed", async () => {
  // Given an independent daemon-side ToolExecutor with a real MCP tree.
  const dir = await mkdtemp(join(tmpdir(), "mcp-owner-")), receipt = join(dir, "receipt");
  const owner = Bun.spawn([process.execPath, join(import.meta.dir, "mcp-stdio-owner.ts"), receipt], { stdout: "pipe", stderr: "inherit" });
  let ids: readonly number[] = [];
  try {
    const reader = owner.stdout.getReader();
    const ready = await reader.read(); reader.releaseLock();
    expect(new TextDecoder().decode(ready.value)).toBe("connected\n");
    ids = await pids(receipt);
    // When the daemon exits without any JS cleanup.
    owner.kill("SIGKILL"); await owner.exited;
    // Then the supervisor terminates the entire owned group.
    await eventually(async () => (await Promise.all(ids.map(live))).every(value => !value));
    expect(await Promise.all(ids.map(live))).toEqual([false, false, false]);
    console.log(JSON.stringify({ scenario: "daemon-death", owner: owner.pid, owned: ids, liveAfter: await Promise.all(ids.map(live)) }));
  } finally { if (owner.exitCode === null) owner.kill("SIGKILL"); await owner.exited; await cleanup(ids); await rm(dir, { recursive: true, force: true }); }
}, 15000);

test.skipIf(process.platform !== "linux")("stdio cleans descendants when MCP initialization times out", async () => {
  // Given a process tree that never responds to initialize and ignores EOF/TERM.
  const dir = await mkdtemp(join(tmpdir(), "mcp-stall-")), receipt = join(dir, "receipt"), tools = new ToolExecutor();
  let ids: readonly number[] = [];
  try {
    // When the actual protocol connection times out.
    const connected = tools.addMcp("stall", { transport: "stdio", command: process.execPath, args: [fixture, "stall", receipt] }, {}).then(() => "connected", error => { if (!(error instanceof Error)) throw error; return mcpConnectionFailure(error); });
    ids = await pids(receipt);
    expect(await connected).toBe("connection_timeout");
    // Then failed initialization releases the complete process tree.
    await eventually(async () => (await Promise.all(ids.map(live))).every(value => !value));
    expect(await Promise.all(ids.map(live))).toEqual([false, false, false]);
    expect(tools.mcpStatus("stall")).toEqual({ connected: false, tool_count: 0 });
    console.log(JSON.stringify({ scenario: "initialize-timeout", owned: ids, liveAfter: await Promise.all(ids.map(live)) }));
  } finally { await cleanup(ids); await tools.close(); await rm(dir, { recursive: true, force: true }); }
}, 20000);
