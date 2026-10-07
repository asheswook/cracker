import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { z } from "zod";
import { resolve } from "node:path";
import { shellEnvironment, shellSecrets, ShellRedactor, shellCommand } from "./shell-output.ts";
import { ShellError } from "./shell.ts";
import { boundShellDrain } from "./shell-drain.ts";

const limits = { yield_ms: z.number().int().min(0).max(10000).default(1000), max_output_chars: z.number().int().min(1).max(100000).default(16000) };
export const ShellStart = z.object({ command: z.string().min(1), cwd: z.string().min(1).nullable().default(null), ...limits }).strict();
export const ShellSession = z.object({ session_id: z.string().uuid(), action: z.enum(["poll", "input", "interrupt", "close"]), input: z.string().max(100000).nullable().default(null), ...limits }).strict();
type ReadOptions = z.infer<typeof ShellStart> | z.infer<typeof ShellSession>;
const retainedLimit = 1_000_000;

class Session {
  readonly id = crypto.randomUUID();
  readonly child: ChildProcessWithoutNullStreams;
  readonly done: Promise<void>;
  private output = "";
  private dropped = 0;
  private exited = false;
  private exitCode: number | null = null;
  private exitSignal: NodeJS.Signals | null = null;
  private outputClosedEarly = false;
  private failure: Error | undefined;
  private killTimer: ReturnType<typeof setTimeout> | undefined;
  private readonly listeners = new Set<() => void>();

  constructor(readonly cwd: string, command: string, context: { readonly workspace: string | undefined; readonly signal: AbortSignal }) {
    const [program, ...args] = shellCommand(["bash", "-lc", command]);
    this.child = spawn(program, args, { cwd, env: shellEnvironment(context.workspace), detached: true, stdio: ["pipe", "pipe", "pipe"] });
    boundShellDrain(this.child, () => { this.outputClosedEarly = true; });
    const secrets = shellSecrets();
    for (const stream of [this.child.stdout, this.child.stderr]) {
      const redactor = new ShellRedactor(secrets);
      stream.setEncoding("utf8");
      stream.on("data", (text: string) => this.append(redactor.push(text)));
      stream.on("end", () => this.append(redactor.push("", true)));
    }
    const abort = (): void => this.terminate();
    this.done = new Promise(resolveDone => {
      this.child.on("error", () => { this.failure = new ShellError("shell_spawn_failed"); this.notify(); });
      this.child.stdin.on("error", error => { if (!("code" in error && error.code === "EPIPE")) this.failure = new ShellError("shell_input_failed"); });
      this.child.on("exit", () => this.kill("SIGKILL"));
      this.child.on("close", (code, signal) => {
        this.exited = true; this.exitCode = code; this.exitSignal = signal;
        context.signal.removeEventListener("abort", abort);
        if (this.killTimer) clearTimeout(this.killTimer);
        this.notify(); resolveDone();
      });
    });
    context.signal.addEventListener("abort", abort, { once: true });
    if (context.signal.aborted) abort();
  }
  pending(): boolean { return !this.exited || this.output.length > 0 || this.dropped > 0; }
  private notify(): void { for (const listener of this.listeners) listener(); }
  private append(text: string): void {
    this.output += text;
    const overflow = Math.max(0, this.output.length - retainedLimit);
    this.dropped += overflow; this.output = this.output.slice(overflow);
    if (text) this.notify();
  }
  private kill(signal: NodeJS.Signals): void {
    if (!this.child.pid) return;
    try { process.kill(-this.child.pid, signal); }
    catch (error) { if (!(error instanceof Error && "code" in error && error.code === "ESRCH")) this.failure = new ShellError("shell_signal_failed"); }
  }
  terminate(): void {
    if (this.exited || this.killTimer) return;
    this.kill("SIGTERM"); this.killTimer = setTimeout(() => this.kill("SIGKILL"), 500);
  }
  interrupt(): void { if (!this.exited) this.kill("SIGINT"); }
  write(input: string): void {
    if (this.exited || this.child.stdin.destroyed) throw new ShellError("shell_session_exited");
    if (this.child.stdin.writableLength + Buffer.byteLength(input) > 100000) throw new ShellError("shell_input_backpressure_retry_after_consumption");
    this.child.stdin.write(input);
  }
  async read(options: ReadOptions): Promise<string> {
    if (!this.output && !this.exited && !this.failure && options.yield_ms > 0) {
      await new Promise<void>(resolveWait => {
        const finish = (): void => { clearTimeout(timer); this.listeners.delete(finish); resolveWait(); };
        const timer = setTimeout(finish, options.yield_ms);
        this.listeners.add(finish);
      });
    }
    if (this.failure) throw this.failure;
    const output = this.output.slice(0, options.max_output_chars);
    this.output = this.output.slice(output.length);
    const dropped = this.dropped; this.dropped = 0;
    return JSON.stringify({ session_id: this.id, status: this.exited ? "exited" : "running", exit_code: this.exitCode, signal: this.exitSignal, output, remaining_output_chars: this.output.length, dropped_output_chars: dropped, tty: false, queued_input_bytes: this.child.stdin.writableLength, cwd: this.cwd, ...(this.outputClosedEarly ? { output_closed_early: true } : {}) });
  }
}

export class ShellSessions {
  private readonly sessions = new Map<string, Session>();
  async start(args: string, context: { readonly workspace: string | undefined; readonly signal: AbortSignal }): Promise<string> {
    const options = ShellStart.parse(JSON.parse(args));
    context.signal.throwIfAborted();
    if (this.sessions.size >= 32) throw new ShellError("shell_session_limit_close_unused_sessions");
    const session = new Session(resolve(context.workspace ?? process.cwd(), options.cwd ?? "."), options.command, context);
    this.sessions.set(session.id, session);
    return session.read(options);
  }
  async run(args: string, signal: AbortSignal): Promise<string> {
    const options = ShellSession.parse(JSON.parse(args));
    signal.throwIfAborted();
    const session = this.sessions.get(options.session_id);
    if (!session) throw new ShellError("shell_session_unknown_or_expired");
    switch (options.action) {
      case "poll": break;
      case "input": if (options.input === null) throw new ShellError("shell_input_required"); session.write(options.input); break;
      case "interrupt": session.interrupt(); break;
      case "close": session.terminate(); await session.done; break;
      default: { const exhaustive: never = options.action; throw new ShellError(String(exhaustive)); }
    }
    const result = await session.read(options);
    if (options.action === "close") this.sessions.delete(session.id);
    return result;
  }
  hasPending(): boolean { return [...this.sessions.values()].some(session => session.pending()); }
  async close(): Promise<void> {
    const sessions = [...this.sessions.values()];
    for (const session of sessions) session.terminate();
    await Promise.all(sessions.map(session => session.done));
    this.sessions.clear();
  }
}
