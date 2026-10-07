import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";
import { DesktopError } from "./desktop-protocol";

export function startDesktopGuardian(workerPid: number | undefined, env: NodeJS.ProcessEnv) {
  const child = spawn(
    "python3",
    [
      "-I",
      fileURLToPath(new URL("./desktop-guardian.py", import.meta.url)),
      ...(workerPid === undefined ? ["--release"] : [String(process.pid), String(workerPid)]),
    ],
    {
      env,
      detached: true,
      stdio: ["ignore", "pipe", "ignore"],
    },
  );
  const kill = () => {
    if (!child.pid) return;
    try {
      process.kill(-child.pid, "SIGKILL");
    } catch (error) {
      if (!(error instanceof Error && "code" in error && error.code === "ESRCH"))
        rejectReady?.(new DesktopError("desktop_guardian_termination_failed"));
    }
  };
  let ready = false,
    released = false,
    buffer = "";
  let acceptReady: (() => void) | undefined;
  let rejectReady: ((error: DesktopError) => void) | undefined;
  const started = new Promise<void>((resolve, reject) => {
    acceptReady = resolve;
    rejectReady = reject;
  });
  const startup = setTimeout(
    () => rejectReady?.(new DesktopError("desktop_guardian_start_timeout")),
    5000,
  );
  child.stdout.on("data", (chunk: Buffer) => {
    buffer += chunk.toString("ascii");
    if (buffer.length > 1024) {
      rejectReady?.(new DesktopError("desktop_guardian_protocol_invalid"));
      kill();
      return;
    }
    for (let newline = buffer.indexOf("\n"); newline >= 0; newline = buffer.indexOf("\n")) {
      const line = buffer.slice(0, newline);
      buffer = buffer.slice(newline + 1);
      if (line === '{"ready": true}' && !ready) {
        ready = true;
        clearTimeout(startup);
        acceptReady?.();
      } else if (line === '{"released": true}' && ready) released = true;
      else {
        rejectReady?.(new DesktopError("desktop_guardian_protocol_invalid"));
        kill();
      }
    }
  });
  const completed = new Promise<void>((resolve, reject) => {
    const fail = () => {
      const error = new DesktopError("desktop_guardian_failed");
      clearTimeout(startup);
      rejectReady?.(error);
      reject(error);
    };
    child.once("error", fail);
    child.once("exit", (code) => {
      clearTimeout(startup);
      if (code === 0 && ready && released) resolve();
      else fail();
    });
  });
  return {
    pid: child.pid,
    started,
    completed,
    async finish(): Promise<void> {
      let timer: ReturnType<typeof setTimeout> | undefined;
      try {
        await Promise.race([
          completed,
          new Promise<void>((_resolve, reject) => {
            timer = setTimeout(() => {
              kill();
              reject(new DesktopError("desktop_guardian_cleanup_timeout"));
            }, 5000);
          }),
        ]);
      } finally {
        clearTimeout(timer);
        child.stdout.destroy();
      }
    },
  };
}
