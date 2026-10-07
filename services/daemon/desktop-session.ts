import { type ChildProcessWithoutNullStreams, execFile, spawn } from "node:child_process";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { StringDecoder } from "node:string_decoder";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import { startDesktopGuardian } from "./desktop-guardian";
import { DesktopError, DesktopRequest, WorkerMessage } from "./desktop-protocol";

export { computerExecTool } from "./desktop-protocol";

const execute = promisify(execFile);
function environment() {
  return Object.fromEntries(
    ["PATH", "HOME", "DISPLAY", "XAUTHORITY", "LANG", "LC_ALL"].flatMap((name) => {
      const value = process.env[name];
      return value === undefined ? [] : [[name, value]];
    }),
  );
}
type Result = Extract<WorkerMessage, { kind: "result" }>;
type Pending = {
  readonly id: string;
  readonly resolve: (value: Result) => void;
  readonly reject: (error: DesktopError) => void;
};
export class PersistentDesktop {
  private worker: ChildProcessWithoutNullStreams | undefined;
  private directory: string | undefined;
  private workspace: string | undefined;
  private pending: Pending | undefined;
  private buffer = "";
  private stopping: Promise<void> | undefined;
  private generation = 0;
  private running = false;
  private epoch = 0;
  private guardian: ReturnType<typeof startDesktopGuardian> | undefined;
  private terminalFailure: DesktopError | undefined;
  async reset(workspace?: string): Promise<void> {
    await this.close();
    this.workspace = workspace;
  }
  private async start() {
    if (this.worker) return;
    if (!this.workspace) throw new DesktopError("desktop_session_unbound");
    if (process.platform !== "linux") throw new DesktopError("desktop_linux_required");
    const epoch = this.epoch;
    const directory = await mkdtemp(join(tmpdir(), "assistant-desktop-"));
    if (epoch !== this.epoch) {
      await rm(directory, { recursive: true, force: true });
      throw new DesktopError("desktop_session_closed");
    }
    this.directory = directory;
    const worker = spawn(
      process.execPath,
      [fileURLToPath(new URL("./desktop-worker.ts", import.meta.url))],
      {
        cwd: this.workspace,
        env: { ...environment(), DESKTOP_SESSION_DIR: this.directory },
        detached: true,
        stdio: ["pipe", "pipe", "pipe"],
      },
    );
    this.worker = worker;
    this.buffer = "";
    const decoder = new StringDecoder("utf8");
    this.generation++;
    worker.stderr.resume();
    worker.stdout.on("data", (chunk: Buffer) => {
      if (this.worker !== worker) return;
      this.buffer += decoder.write(chunk);
      if (this.buffer.length > 13 * 1024 * 1024) {
        this.pending?.reject(new DesktopError("desktop_output_limit"));
        this.stopInBackground();
        return;
      }
      let newline = this.buffer.indexOf("\n");
      while (newline >= 0) {
        const line = this.buffer.slice(0, newline);
        this.buffer = this.buffer.slice(newline + 1);
        try {
          const value = WorkerMessage.parse(JSON.parse(line));
          if (value.kind === "result" && this.pending?.id === value.id) this.pending.resolve(value);
        } catch {
          this.pending?.reject(new DesktopError("desktop_protocol_invalid"));
          this.stopInBackground();
        }
        newline = this.buffer.indexOf("\n");
      }
    });
    const failed = (code: string) => {
      if (this.worker === worker) this.pending?.reject(new DesktopError(code));
    };
    worker.stdin.on("error", () => failed("desktop_write_failed"));
    worker.once("error", () => failed("desktop_worker_failed"));
    worker.once("exit", () => failed("desktop_worker_exited"));
    if (!worker.pid) throw new DesktopError("desktop_worker_failed");
    const guardian = startDesktopGuardian(worker.pid, environment());
    this.guardian = guardian;
    void guardian.completed.catch((error: unknown) => {
      if (this.guardian !== guardian) return;
      this.pending?.reject(
        error instanceof DesktopError ? error : new DesktopError("desktop_guardian_failed"),
      );
      this.stopInBackground();
    });
    await guardian.started;
  }
  async run(
    args: string,
    signal: AbortSignal,
  ): Promise<{
    readonly text: string;
    readonly image: string;
    readonly images: readonly string[];
  }> {
    if (this.terminalFailure) throw this.terminalFailure;
    if (this.running || this.stopping) throw new DesktopError("desktop_busy");
    this.running = true;
    try {
      return await this.runBatch(args, signal);
    } catch (error) {
      await this.stop();
      throw error;
    } finally {
      this.running = false;
    }
  }
  private async runBatch(
    args: string,
    signal: AbortSignal,
  ): Promise<{
    readonly text: string;
    readonly image: string;
    readonly images: readonly string[];
  }> {
    signal.throwIfAborted();
    const request = DesktopRequest.parse(JSON.parse(args));
    if (this.pending || this.stopping) throw new DesktopError("desktop_busy");
    await this.start();
    signal.throwIfAborted();
    const worker = this.worker;
    if (!worker) throw new DesktopError("desktop_worker_missing");
    let timer: ReturnType<typeof setTimeout> | undefined;
    let abort: () => void = () => {};
    try {
      const result = await new Promise<Result>((resolve, reject) => {
        const id = crypto.randomUUID();
        this.pending = { id, resolve, reject };
        abort = () => reject(new DesktopError("desktop_aborted"));
        signal.addEventListener("abort", abort, { once: true });
        timer = setTimeout(() => reject(new DesktopError("desktop_timeout")), request.timeout_ms);
        worker.stdin.write(`${JSON.stringify({ ...request, id })}\n`, (error) => {
          if (error) reject(new DesktopError("desktop_write_failed"));
        });
        if (signal.aborted) abort();
      });
      return {
        text: JSON.stringify({
          ok: result.ok,
          result: JSON.parse(result.result),
          steps: result.steps,
          elapsed_ms: result.elapsed_ms,
          session_generation: this.generation,
          width: result.width,
          height: result.height,
        }),
        image: result.image,
        images: [...(result.images ?? []), result.image].filter(
          (frame, index, frames) => index === 0 || frame !== frames[index - 1],
        ),
      };
    } catch (error) {
      await this.stop();
      throw error;
    } finally {
      if (timer) clearTimeout(timer);
      signal.removeEventListener("abort", abort);
      this.pending = undefined;
    }
  }
  private stopInBackground(): void {
    void this.stop().catch((error: unknown) => {
      const failure =
        error instanceof DesktopError ? error : new DesktopError("desktop_cleanup_failed");
      this.terminalFailure = failure;
      console.error(JSON.stringify({ event: "desktop_cleanup_failed", code: failure.code }));
    });
  }
  private stop(): Promise<void> {
    if (this.terminalFailure) return Promise.reject(this.terminalFailure);
    if (this.stopping) return this.stopping;
    const stopping = this.stopWorker().catch((error: unknown) => {
      const failure =
        error instanceof DesktopError ? error : new DesktopError("desktop_cleanup_failed");
      this.terminalFailure = failure;
      throw failure;
    });
    this.stopping = stopping;
    void stopping.then(
      () => {
        this.stopping = undefined;
      },
      (error: unknown) => {
        this.terminalFailure =
          error instanceof DesktopError ? error : new DesktopError("desktop_cleanup_failed");
      },
    );
    return stopping;
  }
  private async stopWorker() {
    const worker = this.worker,
      directory = this.directory,
      guardian = this.guardian;
    this.worker = undefined;
    this.directory = undefined;
    this.guardian = undefined;
    this.pending?.reject(new DesktopError("desktop_session_closed"));
    let failure: DesktopError | undefined;
    if (worker) {
      const kill = (signal: NodeJS.Signals) => {
        if (!worker.pid) return;
        try {
          process.kill(-worker.pid, signal);
        } catch (error) {
          if (!(error instanceof Error && "code" in error && error.code === "ESRCH")) {
            failure = new DesktopError("desktop_termination_failed");
          }
        }
      };
      const exited =
        !worker.pid || worker.exitCode !== null || worker.signalCode !== null
          ? Promise.resolve()
          : new Promise<void>((resolve) => worker.once("exit", () => resolve()));
      kill("SIGTERM");
      let grace: ReturnType<typeof setTimeout> | undefined;
      await Promise.race([
        exited,
        new Promise<void>((resolve) => {
          grace = setTimeout(resolve, 200);
        }),
      ]);
      clearTimeout(grace);
      kill("SIGKILL");
      let deadline: ReturnType<typeof setTimeout> | undefined;
      const confirmed = await Promise.race([
        exited.then(() => true),
        new Promise<boolean>((resolve) => {
          deadline = setTimeout(() => resolve(false), 1000);
        }),
      ]);
      clearTimeout(deadline);
      if (!confirmed) failure = new DesktopError("desktop_termination_unconfirmed");
      worker.stdin.destroy();
      worker.stdout.destroy();
      worker.stderr.destroy();
      try {
        if (guardian) await guardian.finish();
        else
          await execute(
            "python3",
            [fileURLToPath(new URL("./desktop-release.py", import.meta.url))],
            { env: environment(), timeout: 3000, maxBuffer: 1024 },
          );
      } catch (error) {
        if (error instanceof DesktopError) failure = error;
        else if (error instanceof Error) failure = new DesktopError("desktop_input_release_failed");
        else failure = new DesktopError("desktop_cleanup_failed");
      }
    }
    if (directory) {
      try {
        await rm(directory, { recursive: true, force: true });
      } catch (error) {
        if (!failure)
          failure = new DesktopError(
            error instanceof Error ? "desktop_directory_cleanup_failed" : "desktop_cleanup_failed",
          );
      }
    }
    if (failure) throw failure;
  }
  async releaseInputs(): Promise<void> {
    await this.close();
    if (process.platform !== "linux" || !process.env["DISPLAY"]?.trim()) return;
    const guardian = startDesktopGuardian(undefined, environment());
    const results = await Promise.allSettled([guardian.started, guardian.finish()]);
    if (results.some((result) => result.status === "rejected")) {
      this.terminalFailure = new DesktopError("desktop_input_barrier_failed");
      throw this.terminalFailure;
    }
  }
  async close(): Promise<void> {
    this.epoch++;
    await this.stop();
  }
}
