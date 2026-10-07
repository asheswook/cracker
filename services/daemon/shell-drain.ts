import type { ChildProcess } from "node:child_process";

export function boundShellDrain(child: ChildProcess, onCutoff: () => void): void {
  let timer: ReturnType<typeof setTimeout> | undefined;
  child.once("exit", () => {
    timer = setTimeout(() => {
      const streams = [child.stdout, child.stderr].filter(stream => stream && !stream.destroyed && !stream.readableEnded);
      if (streams.length) onCutoff();
      child.stdin?.destroy();
      for (const stream of streams) stream?.destroy();
    }, 250);
  });
  child.once("close", () => { if (timer) clearTimeout(timer); });
}
