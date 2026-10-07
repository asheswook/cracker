import { expect, test } from "bun:test";
import { execFile, spawn } from "node:child_process";
import { once } from "node:events";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import { z } from "zod";
import { PersistentDesktop } from "../services/daemon/desktop-session";

const command = promisify(execFile);
const enabled = process.platform === "linux" && process.env["RUN_LINUX_ACCEPTANCE"] === "1";
const pointerMask = `import ctypes
x=ctypes.CDLL('libX11.so.6');x.XOpenDisplay.restype=ctypes.c_void_p
x.XDefaultRootWindow.argtypes=[ctypes.c_void_p];x.XDefaultRootWindow.restype=ctypes.c_ulong
x.XQueryPointer.argtypes=[ctypes.c_void_p,ctypes.c_ulong,ctypes.c_void_p,ctypes.c_void_p,ctypes.c_void_p,ctypes.c_void_p,ctypes.c_void_p,ctypes.c_void_p,ctypes.c_void_p]
d=x.XOpenDisplay(None);a=ctypes.c_ulong();b=ctypes.c_ulong();v=[ctypes.c_int() for _ in range(4)];m=ctypes.c_uint()
x.XQueryPointer(d,x.XDefaultRootWindow(d),ctypes.byref(a),ctypes.byref(b),*[ctypes.byref(i) for i in v],ctypes.byref(m));print(m.value)
`;
async function exited(pid: number) {
  await command(
    "python3",
    [
      "-c",
      `import os,select,sys
try: fd=os.pidfd_open(int(sys.argv[1]))
except ProcessLookupError: sys.exit(0)
ready,_,_=select.select([fd],[],[],8)
os.close(fd)
sys.exit(0 if ready else 1)`,
      String(pid),
    ],
    { timeout: 9000 },
  );
}
test.skipIf(!enabled)(
  "parent SIGKILL stops blocked JS and its held-input child before guardian exits",
  async () => {
    // Given an isolated display and a worker blocked in synchronous JS after spawning held input.
    const xvfb = spawn(
      "Xvfb",
      ["-displayfd", "1", "-screen", "0", "640x480x24", "-nolisten", "tcp", "-ac"],
      { stdio: ["ignore", "pipe", "ignore"] },
    );
    const display = `:${String((await once(xvfb.stdout, "data"))[0]).trim()}`;
    const directory = await mkdtemp(join(tmpdir(), "desktop-parent-crash-"));
    const previousDisplay = process.env["DISPLAY"];
    process.env["DISPLAY"] = display;
    const xev = spawn("xev", ["-geometry", "300x200+0+0", "-event", "mouse"], {
      stdio: ["ignore", "pipe", "ignore"],
    });
    let parent: ReturnType<typeof spawn> | undefined;
    const next = new PersistentDesktop();
    try {
      await command("xdotool", ["search", "--sync", "--name", "Event Tester"], { timeout: 3000 });
      await command("xdotool", ["mousemove", "50", "50"]);
      const pressed = new Promise<void>((resolve) => {
        xev.stdout.on("data", (data: Buffer) => {
          if (data.toString().includes("ButtonPress")) resolve();
        });
      });
      parent = spawn(
        process.execPath,
        [fileURLToPath(new URL("./fixtures/desktop-crash-parent.ts", import.meta.url)), directory],
        { stdio: "ignore" },
      );
      await pressed;
      const ids = z
        .object({ worker: z.number().int(), child: z.number().int() })
        .parse(await Bun.file(join(directory, "worker.json")).json());
      const children = (await Bun.file(`/proc/${parent.pid}/task/${parent.pid}/children`).text())
        .trim()
        .split(/\s+/)
        .map(Number);
      const guardian = children.find((pid) => pid !== ids.worker);
      expect(guardian).toBeDefined();
      if (!guardian) throw new Error("Missing guardian");
      // When the supervising daemon is killed while JavaScript cannot service timers.
      parent.kill("SIGKILL");
      await Promise.all([exited(ids.worker), exited(ids.child), exited(guardian)]);
      // Then both execution processes are dead and release completed before a fresh task begins.
      expect(Number((await command("python3", ["-c", pointerMask])).stdout.trim()) & 256).toBe(0);
      await next.reset(directory);
      const result = await next.run(
        JSON.stringify({ code: "return state.prior??null;", timeout_ms: 5000 }),
        new AbortController().signal,
      );
      expect(JSON.parse(result.text).result).toBeNull();
      const orderlyGuardian = next["guardian"]?.pid;
      if (!orderlyGuardian) throw new Error("Missing live guardian");
      await next.close();
      await exited(orderlyGuardian);
      // Simulate held input surviving whole-cgroup SIGKILL: startup must reset it before dispatch.
      await command("xdotool", ["mousedown", "1"]);
      expect(Number((await command("python3", ["-c", pointerMask])).stdout.trim()) & 256).toBe(256);
      const idle = new PersistentDesktop();
      await idle.releaseInputs();
      expect(idle["worker"]).toBeUndefined();
      expect(Number((await command("python3", ["-c", pointerMask])).stdout.trim()) & 256).toBe(0);
      await idle.close();
      await command("xdotool", ["mousedown", "1"]);
      await next.reset(directory);
      await next.run(
        JSON.stringify({ code: "return 1;", timeout_ms: 5000 }),
        new AbortController().signal,
      );
      expect(Number((await command("python3", ["-c", pointerMask])).stdout.trim()) & 256).toBe(0);
      const competingBarrier = new PersistentDesktop();
      await command("xdotool", ["mousedown", "1"]);
      await expect(competingBarrier.releaseInputs()).rejects.toThrow(
        "desktop_input_barrier_failed",
      );
      expect(Number((await command("python3", ["-c", pointerMask])).stdout.trim()) & 256).toBe(256);
      await command("xdotool", ["mouseup", "1"]);
      const dyingGuardian = next["guardian"]?.pid;
      if (!dyingGuardian) throw new Error("Missing failure guardian");
      const guardedWorker = next["worker"]?.pid;
      if (!guardedWorker) throw new Error("Missing guarded worker");
      process.kill(dyingGuardian, "SIGKILL");
      await exited(guardedWorker);
      await expect(next.close()).rejects.toThrow("desktop_guardian_failed");
      await expect(next.reset(directory)).rejects.toThrow("desktop_guardian_failed");
      console.log(
        JSON.stringify({
          scenario: "parent_sigkill_blocked_worker",
          worker_exited: true,
          inflight_xdotool_exited: true,
          guardian_exited: true,
          held_input_released: true,
          next_task_startup_reset: true,
          idle_takeover_barrier_without_worker: true,
        }),
      );
    } finally {
      try {
        await next.close();
      } catch (error) {
        if (!(error instanceof Error && error.message === "desktop_guardian_failed")) throw error;
      }
      parent?.kill("SIGKILL");
      xev.kill("SIGTERM");
      xvfb.kill("SIGTERM");
      if (previousDisplay === undefined) delete process.env["DISPLAY"];
      else process.env["DISPLAY"] = previousDisplay;
      await rm(directory, { recursive: true, force: true });
    }
  },
  20000,
);
