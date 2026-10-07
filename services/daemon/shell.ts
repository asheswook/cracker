import { spawn } from "node:child_process";
import { shellEnvironment, shellSecrets, ShellRedactor, shellCommand } from "./shell-output.ts";
import { boundShellDrain } from "./shell-drain.ts";
export class ShellError extends Error { constructor(readonly code: string) { super(code); this.name = "ShellError"; } }
export async function execute(argv: readonly string[], signal: AbortSignal, workspace?: string, timeoutMs = 60000): Promise<string> {
  signal.throwIfAborted();
  if (!argv[0]) throw new ShellError("empty_command");
  const [program, ...args] = shellCommand(argv);
  const environment = shellEnvironment(workspace);
  const secrets = shellSecrets();
  return new Promise((resolve, reject) => {
    const child = spawn(program, args, { detached: true, stdio: ["ignore", "pipe", "pipe"], env: environment, ...(workspace ? { cwd: workspace } : {}) });
    let output = "", dropped = 0, outputClosedEarly = false, timedOut = false;
    boundShellDrain(child, () => { outputClosedEarly = true; });
    let killTimer: ReturnType<typeof setTimeout> | undefined;
    const kill = (kind: NodeJS.Signals): void => {
      if (!child.pid) return;
      try { process.kill(-child.pid, kind); }
      catch (error) { if (!(error instanceof Error && "code" in error && error.code === "ESRCH")) reject(error); }
    };
    const abort = (): void => { kill("SIGTERM"); killTimer = setTimeout(() => kill("SIGKILL"), 500); };
    const deadline = setTimeout(() => { timedOut = true; abort(); }, timeoutMs);
    const append = (text: string): void => { const full = output + text; const overflow = Math.max(0, full.length - 100000); dropped += overflow; output = full.slice(overflow); };
    for (const stream of [child.stdout, child.stderr]) {
      const redactor = new ShellRedactor(secrets);
      stream.setEncoding("utf8");
      stream.on("data", (text: string) => append(redactor.push(text)));
      stream.on("end", () => append(redactor.push("", true)));
    }
    child.on("exit", () => { clearTimeout(deadline); kill("SIGKILL"); });
    signal.addEventListener("abort", abort, { once: true });
    if (signal.aborted) abort();
    child.on("error", error => { clearTimeout(deadline); signal.removeEventListener("abort", abort); reject(error); });
    child.on("close", code => {
      signal.removeEventListener("abort", abort);
      clearTimeout(deadline);
      if (killTimer) clearTimeout(killTimer);
      kill("SIGKILL");
      if (signal.aborted) reject(new ShellError("aborted"));
      else resolve(JSON.stringify({ exit_code: code, output, ...(dropped ? { dropped_output_chars: dropped } : {}), ...(outputClosedEarly ? { output_closed_early: true } : {}), ...(timedOut ? { timed_out: true, continuation: "The blocking command exceeded its time limit and was terminated. Inspect existing effects before deciding what remains; do not replay blindly. Use shell_start for long-running work." } : {}) }));
    });
  });
}
