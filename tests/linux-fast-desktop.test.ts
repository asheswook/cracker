import { expect, test } from "bun:test";
import { execFile, spawn } from "node:child_process";
import { once } from "node:events";
import { chmod, mkdir, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import { z } from "zod";
import { runComputer } from "../services/daemon/computer";
import { PersistentDesktop } from "../services/daemon/desktop-session";

const command = promisify(execFile);
const enabled = process.platform === "linux" && process.env["RUN_LINUX_ACCEPTANCE"] === "1";
const Result = z.object({
  ok: z.boolean(),
  result: z.unknown(),
  steps: z.number(),
  session_generation: z.number(),
  width: z.number(),
  height: z.number(),
});
test.skipIf(!enabled)(
  "persistent desktop batches real X11 actions with final pixels, bounded state and cancellation",
  async () => {
    const desktop = spawn(
      "Xvfb",
      ["-displayfd", "1", "-screen", "0", "640x480x24", "-nolisten", "tcp", "-ac"],
      { stdio: ["ignore", "pipe", "ignore"] },
    );
    const display = `:${String((await once(desktop.stdout, "data"))[0]).trim()}`;
    const previousDisplay = process.env["DISPLAY"],
      previousSecret = process.env["VM_TOKEN"];
    process.env["DISPLAY"] = display;
    process.env["VM_TOKEN"] = "test-parent-only-secret";
    const directory = await mkdtemp(join(tmpdir(), "desktop-batch-test-"));
    const session = new PersistentDesktop();
    const run = async (code: string, timeout_ms = 10000, signal = new AbortController().signal) => {
      const result = await session.run(JSON.stringify({ code, timeout_ms }), signal);
      expect(result.image).toStartWith("data:image/png;base64,");
      const png = Buffer.from(result.image.split(",")[1] ?? "", "base64");
      expect(png.subarray(1, 4).toString()).toBe("PNG");
      return {
        ...Result.parse(JSON.parse(result.text)),
        image: result.image,
        images: result.images,
      };
    };
    try {
      await session.reset(directory);
      const observation = await run("return null;");
      expect(observation.steps).toBe(0);
      expect(observation.images).toEqual([observation.image]);
      const duplicate = await run("await desktop.screenshot();");
      expect(duplicate.steps).toBe(1);
      expect(duplicate.images).toEqual([duplicate.image]);
      console.log(
        JSON.stringify({
          scenario: "exact_duplicate_observation",
          automatic_only_frames: observation.images.length,
          explicit_plus_final_frames: duplicate.images.length,
        }),
      );
      const displayClient = spawn(
        "python3",
        [
          "-c",
          "import ctypes,sys;x=ctypes.CDLL('libX11.so.6');x.XOpenDisplay.restype=ctypes.c_void_p;d=x.XOpenDisplay(None);print('ready',flush=True);sys.stdin.read()",
        ],
        { stdio: ["pipe", "pipe", "ignore"] },
      );
      await once(displayClient.stdout, "data");
      try {
        const revisits = await run(`
const fixture=state.constructor.constructor("return process")().getBuiltinModule("node:child_process");
fixture.execFileSync("xsetroot",["-solid","#112233"]); await desktop.screenshot();
fixture.execFileSync("xsetroot",["-solid","#334455"]); await desktop.screenshot();
fixture.execFileSync("xsetroot",["-solid","#112233"]);
`);
        expect(revisits.ok).toBe(true);
        expect(revisits.images).toHaveLength(3);
        expect(revisits.images[0]).toBe(revisits.images[2]);
        expect(revisits.images[0]).not.toBe(revisits.images[1]);
        await command("xsetroot", ["-solid", "black"]);
        console.log(
          JSON.stringify({ scenario: "exact_revisit_order", frames: 3, sequence: "A,B,A" }),
        );
      } finally {
        const disconnected = once(displayClient, "exit");
        displayClient.stdin.end();
        await disconnected;
      }
      const first = await run(
        'state.count=(state.count??0)+1; await desktop.move(20,30); return {count:state.count,secret:state.constructor.constructor("return process")().env.VM_TOKEN??null};',
      );
      expect(first.result).toEqual({ count: 1, secret: null });
      expect(first.width).toBe(640);
      expect(first.height).toBe(480);
      const splitUnicode = await run(`
const native=state.constructor.constructor("return {process,Buffer,setTimeout}")();
const write=native.process.stdout.write.bind(native.process.stdout);
native.process.stdout.write=(value)=>{native.process.stdout.write=write;const bytes=native.Buffer.from(value);const at=bytes.indexOf(native.Buffer.from("한"))+1;write(bytes.subarray(0,at));native.setTimeout(()=>write(bytes.subarray(at)),20);return true;};
return "한글😀";
`);
      expect(splitUnicode.result).toBe("한글😀");
      const second = await run("state.count++; return state.count;");
      expect(second.result).toBe(2);
      expect(second.session_generation).toBe(first.session_generation);
      const start = performance.now();
      for (const [x, y] of [
        [40, 40],
        [50, 50],
        [60, 60],
        [70, 70],
        [80, 80],
        [90, 90],
      ])
        await runComputer(
          JSON.stringify({ action: "move", x, y, text: "" }),
          new AbortController().signal,
        );
      await runComputer(
        JSON.stringify({ action: "screenshot", x: 0, y: 0, text: "" }),
        new AbortController().signal,
      );
      const separateMs = performance.now() - start;
      const batchStart = performance.now();
      const batch = await run(
        'for(let i=4;i<=9;i++) await desktop.move(i*10,i*10); return "six moves";',
      );
      const batchMs = performance.now() - batchStart;
      expect(batch.steps).toBe(6);
      expect(batch.ok).toBe(true);
      console.log(
        JSON.stringify({
          scenario: "actual_x11_batch_latency",
          separate_tool_calls: 7,
          batch_tool_calls: 1,
          separate_ms: Math.round(separateMs),
          batch_ms: Math.round(batchMs),
          includes_final_screenshot: true,
        }),
      );
      const reader = join(directory, "reader.py"),
        valueFile = join(directory, "mixed-value.txt");
      await Bun.write(
        reader,
        `import sys,time
value=sys.stdin.readline().rstrip("\\n")
open(${JSON.stringify(valueFile)},"w").write(value)
print("Batch received")
time.sleep(30)
`,
      );
      const terminal = spawn(
        "xfce4-terminal",
        ["--disable-server", "--title=Fast Desktop QA", "--execute", "python3", reader],
        { env: { ...process.env, DISPLAY: display }, stdio: "ignore" },
      );
      try {
        const windows = await command(
          "xdotool",
          ["search", "--sync", "--onlyvisible", "--name", "Fast Desktop QA"],
          { timeout: 3000 },
        );
        const window = windows.stdout.trim().split("\n")[0];
        if (!window) throw new Error("Missing terminal");
        await command(
          "xdotool",
          [
            "windowmove",
            window,
            "10",
            "10",
            "windowsize",
            window,
            "400",
            "300",
            "windowfocus",
            "--sync",
            window,
          ],
          { timeout: 3000 },
        );
        const snapshots = await run(
          'await desktop.type("FIRST"); await desktop.wait(50); await desktop.screenshot(); await desktop.key("ctrl+u"); await desktop.type("SECOND"); await desktop.wait(50); await desktop.screenshot(); await desktop.key("ctrl+u");',
        );
        expect(snapshots.images).toHaveLength(3);
        await mkdir(".omo/evidence/cua-comparison", { recursive: true });
        for (const [index, frame] of snapshots.images.entries())
          await Bun.write(
            `.omo/evidence/cua-comparison/frame-${index}.png`,
            Buffer.from(frame.split(",")[1] ?? "", "base64"),
          );
        expect(snapshots.images[0]).not.toBe(snapshots.images[1]);
        expect(snapshots.images[2]).toBe(snapshots.image);
        for (const frame of snapshots.images)
          expect(
            Buffer.from(frame.split(",")[1] ?? "", "base64")
              .subarray(1, 4)
              .toString(),
          ).toBe("PNG");
        console.log(
          JSON.stringify({
            scenario: "intermediate_snapshots",
            distinct_visible_states: true,
            explicit: 2,
            final: 1,
          }),
        );
        const mixed = await run(
          'await desktop.click(70,90); await desktop.type("FAST-BATCH 한글 😀"); await desktop.key("Return"); await desktop.scroll(1); const size=await desktop.screenshot(); return size.width;',
        );
        expect(mixed.ok).toBe(true);
        expect(mixed.result).toBe(640);
        expect(mixed.steps).toBe(5);
        expect(await Bun.file(valueFile).text()).toBe("FAST-BATCH 한글 😀");
        await mkdir(".omo/evidence/fast-desktop", { recursive: true });
        await Bun.write(
          ".omo/evidence/fast-desktop/mixed-batch.png",
          Buffer.from(mixed.image.split(",")[1] ?? "", "base64"),
        );
        console.log(
          JSON.stringify({
            scenario: "mixed_actions_terminal_roundtrip",
            actions: ["click", "type", "key", "scroll", "screenshot"],
            exact_unicode: true,
            tool_calls: 1,
          }),
        );
      } finally {
        terminal.kill("SIGTERM");
      }
      const concurrent = run("await desktop.wait(200); return 1;");
      await expect(
        session.run(
          JSON.stringify({ code: "return 2;", timeout_ms: 1000 }),
          new AbortController().signal,
        ),
      ).rejects.toThrow("desktop_busy");
      await concurrent;
      const frameLimit = await run("for(let i=0;i<4;i++) await desktop.screenshot();");
      expect(frameLimit.ok).toBe(false);
      expect(frameLimit.result).toEqual({ error: "screenshot_limit" });
      expect(frameLimit.images).toHaveLength(1);
      const limited = await run("for(let i=0;i<101;i++) await desktop.wait(0);");
      expect(limited.ok).toBe(false);
      expect(limited.result).toEqual({ error: "step_limit" });
      const output = await run('return "a".repeat(17000);');
      expect(output.ok).toBe(false);
      expect(output.result).toEqual({ error: "result_limit" });
      await expect(
        session.run(
          JSON.stringify({ code: 'state.marker="not-replayed"; while(true){}', timeout_ms: 300 }),
          new AbortController().signal,
        ),
      ).rejects.toThrow();
      const restarted = await run("return state.marker??null;");
      expect(restarted.result).toBeNull();
      expect(restarted.session_generation).toBeGreaterThan(first.session_generation);
      const xev = spawn("xev", ["-geometry", "300x200+0+0", "-event", "mouse"], {
        env: { ...process.env, DISPLAY: display },
        stdio: ["ignore", "pipe", "ignore"],
      });
      const aborted = new AbortController();
      let pressed = false;
      xev.stdout.on("data", (value: Buffer) => {
        if (value.toString().includes("ButtonPress")) {
          pressed = true;
          aborted.abort();
        }
      });
      try {
        await command("xdotool", ["search", "--sync", "--name", "Event Tester"], { timeout: 3000 });
        await expect(
          session.run(
            JSON.stringify({
              code: "await desktop.drag(50,50,180,120); await desktop.wait(1000);",
              timeout_ms: 5000,
            }),
            aborted.signal,
          ),
        ).rejects.toThrow("desktop_aborted");
        expect(pressed).toBe(true);
        const mask = await command(
          "python3",
          [
            "-c",
            `import ctypes
x=ctypes.CDLL('libX11.so.6');x.XOpenDisplay.restype=ctypes.c_void_p
x.XDefaultRootWindow.argtypes=[ctypes.c_void_p];x.XDefaultRootWindow.restype=ctypes.c_ulong
x.XQueryPointer.argtypes=[ctypes.c_void_p,ctypes.c_ulong,ctypes.c_void_p,ctypes.c_void_p,ctypes.c_void_p,ctypes.c_void_p,ctypes.c_void_p,ctypes.c_void_p,ctypes.c_void_p]
d=x.XOpenDisplay(None);a=ctypes.c_ulong();b=ctypes.c_ulong();v=[ctypes.c_int() for _ in range(4)];m=ctypes.c_uint()
x.XQueryPointer(d,x.XDefaultRootWindow(d),ctypes.byref(a),ctypes.byref(b),*[ctypes.byref(i) for i in v],ctypes.byref(m));print(m.value)
`,
          ],
          { timeout: 3000 },
        );
        expect(Number(mask.stdout.trim()) & 256).toBe(0);
        console.log(
          JSON.stringify({
            scenario: "abort_during_actual_button_hold",
            pressed: true,
            released_before_return: true,
          }),
        );
      } finally {
        xev.kill("SIGTERM");
      }
      const commandBin = join(directory, "fault-bin");
      await mkdir(commandBin);
      await Bun.write(
        join(commandBin, "xdotool"),
        '#!/bin/sh\nif [ "$1" = "keyup" ]; then exit 1; fi\nexec /usr/bin/xdotool "$@"\n',
      );
      await chmod(join(commandBin, "xdotool"), 0o700);
      const priorPath = process.env["PATH"];
      try {
        process.env["PATH"] = `${commandBin}:${priorPath ?? ""}`;
        await session.reset(directory);
        await expect(
          session.run(
            JSON.stringify({
              code: 'state.unsafe=1; await desktop.key("shift");',
              timeout_ms: 5000,
            }),
            new AbortController().signal,
          ),
        ).rejects.toThrow("desktop_worker_exited");
      } finally {
        if (priorPath === undefined) delete process.env["PATH"];
        else process.env["PATH"] = priorPath;
      }
      expect((await run("return state.unsafe??null;")).result).toBeNull();
      console.log(
        JSON.stringify({
          scenario: "failed_key_release_terminates_worker",
          next_call_fresh_state: true,
        }),
      );
      const racing = new PersistentDesktop();
      await racing.reset(directory);
      const starting = racing
        .run(JSON.stringify({ code: "return 1;", timeout_ms: 1000 }), new AbortController().signal)
        .then(
          () => "unexpected-success",
          (error) => (error instanceof Error ? error.message : "unknown-error"),
        );
      await racing.reset();
      expect(await starting).toBe("desktop_session_closed");
      await session.reset(directory);
      expect((await run("return state.count??null;")).result).toBeNull();
      await session.reset();
      await expect(
        session.run(
          JSON.stringify({ code: "return 1;", timeout_ms: 1000 }),
          new AbortController().signal,
        ),
      ).rejects.toThrow("desktop_session_unbound");
    } finally {
      await session.close();
      if (previousDisplay === undefined) delete process.env["DISPLAY"];
      else process.env["DISPLAY"] = previousDisplay;
      if (previousSecret === undefined) delete process.env["VM_TOKEN"];
      else process.env["VM_TOKEN"] = previousSecret;
      const exited = once(desktop, "exit");
      desktop.kill("SIGTERM");
      await exited;
      await rm(directory, { recursive: true, force: true });
    }
  },
  45000,
);
