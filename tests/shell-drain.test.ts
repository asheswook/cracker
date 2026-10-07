import { test, expect } from "bun:test";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { execute } from "../services/daemon/shell";
import { ShellSessions } from "../services/daemon/shell-session";

async function fixture() {
  const dir = await mkdtemp(join(tmpdir(), "shell-drain-"));
  const pidFile = join(dir, "pid");
  const program = `import {spawn} from 'node:child_process'; import {writeFileSync} from 'node:fs'; const child=spawn(process.execPath,['-e','setInterval(()=>{},1000)'],{detached:true,stdio:['ignore',1,2]}); writeFileSync(${JSON.stringify(pidFile)},String(child.pid)); child.unref(); console.log('parent-finished');`;
  const command = `${JSON.stringify(process.execPath)} -e '${program.replaceAll("'", "'\\''")}'`;
  return { command, async cleanup() {
    const pid = Number(await readFile(pidFile, "utf8"));
    try { process.kill(-pid, "SIGKILL"); }
    catch (error) { if (!(error instanceof Error && "code" in error && error.code === "ESRCH")) throw error; }
    await rm(dir, { recursive: true });
  } };
}

test("blocking shell returns when a detached descendant retains output", async () => {
  const f = await fixture();
  try {
    const result = await Promise.race([execute(["bash", "-lc", f.command], new AbortController().signal), new Promise<never>((_, reject) => setTimeout(() => reject(new Error("output drain hung")), 1800))]);
    expect(JSON.parse(result)).toMatchObject({ exit_code: 0, output: "parent-finished\n", output_closed_early: true });
  } finally { await f.cleanup(); }
});

test("session close returns when a detached descendant retains output", async () => {
  const f = await fixture(), sessions = new ShellSessions(), signal = new AbortController().signal;
  try {
    const result = JSON.parse(await sessions.start(JSON.stringify({ command: f.command, yield_ms: 1000 }), { workspace: undefined, signal }));
    const closed = await Promise.race([sessions.run(JSON.stringify({ session_id: result.session_id, action: "close" }), signal), new Promise<never>((_, reject) => setTimeout(() => reject(new Error("session close hung")), 1800))]);
    expect(JSON.parse(closed).status).toBe("exited");
    expect(sessions.hasPending()).toBe(false);
  } finally { await f.cleanup(); await sessions.close(); }
});

test("blocking shell bounds a command that never exits", async () => {
  const result = await execute(["bash", "-lc", "printf started; exec sleep 60"], new AbortController().signal, undefined, 100);
  expect(JSON.parse(result)).toMatchObject({ output: "started", timed_out: true });
});

test("abort settles even while a detached descendant retains output", async () => {
  const f = await fixture(), controller = new AbortController();
  try {
    const result = execute(["bash", "-lc", f.command], controller.signal);
    const timer = setTimeout(() => controller.abort(), 100);
    try { await expect(result).rejects.toThrow("aborted"); }
    finally { clearTimeout(timer); }
  } finally { await f.cleanup(); }
});
