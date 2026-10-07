import { expect, test } from "bun:test";
import { spawn } from "node:child_process";
import { once } from "node:events";
import { mkdir, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ToolExecutor } from "../services/daemon/tools";

const enabled = process.platform === "linux" && process.env["RUN_LINUX_ACCEPTANCE"] === "1";
test.skipIf(!enabled)(
  "two successful tasks can reuse one ToolExecutor after terminal cleanup",
  async () => {
    const xvfb = spawn(
      "Xvfb",
      ["-displayfd", "1", "-screen", "0", "640x480x24", "-nolisten", "tcp", "-ac"],
      { stdio: ["ignore", "pipe", "ignore"] },
    );
    const display = `:${String((await once(xvfb.stdout, "data"))[0]).trim()}`;
    const prior = process.env["DISPLAY"];
    process.env["DISPLAY"] = display;
    const directory = await mkdtemp(join(tmpdir(), "desktop-repeat-"));
    const tools = new ToolExecutor();
    try {
      await tools.releaseDesktopInputs();
      for (const task of [1, 2]) {
        const output = join(directory, String(task));
        await mkdir(output);
        tools.setWorkspace(output);
        await tools.resetDesktop(output);
        const result = await tools.run(
          "computer_exec",
          JSON.stringify({
            code: "state.count=(state.count??0)+1; return state.count;",
            timeout_ms: 10000,
          }),
          new AbortController().signal,
        );
        expect(JSON.parse(result.text).ok).toBe(true);
        expect(JSON.parse(result.text).result).toBe(1);
        expect(result.images).toHaveLength(1);
        const observation = await tools.run(
          "computer_exec",
          JSON.stringify({ code: "", timeout_ms: 10000 }),
          new AbortController().signal,
        );
        expect(JSON.parse(observation.text).ok).toBe(true);
        expect(JSON.parse(observation.text).steps).toBe(0);
        expect(observation.images).toHaveLength(1);
        await tools.resetDesktop(output);
        tools.setWorkspace(undefined);
        console.log(
          JSON.stringify({
            scenario: "same_executor_successive_task",
            task,
            success: true,
            fresh_state: true,
          }),
        );
      }
    } finally {
      await tools.close();
      xvfb.kill("SIGTERM");
      if (prior === undefined) delete process.env["DISPLAY"];
      else process.env["DISPLAY"] = prior;
      await rm(directory, { recursive: true, force: true });
    }
  },
  15000,
);
