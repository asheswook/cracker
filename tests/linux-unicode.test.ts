import { expect, test } from "bun:test";
import { execFile, spawn } from "node:child_process";
import { once } from "node:events";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import { ScreenInput, x11Executor } from "../packages/screen/input";
import { pasteUnicode } from "../packages/screen/text";
import { ToolExecutor } from "../services/daemon/tools";

const execute = promisify(execFile);
const enabled = process.platform === "linux" && process.env["RUN_LINUX_ACCEPTANCE"] === "1";
test.skipIf(!enabled)(
  "real Chromium receives exact Korean and Unicode text from UTF8 clipboard paste",
  async () => {
    const directory = await mkdtemp(join(tmpdir(), "assistant-unicode-"));
    const displayProcess = spawn(
      "Xvfb",
      ["-displayfd", "1", "-screen", "0", "800x600x24", "-nolisten", "tcp", "-ac"],
      { stdio: ["ignore", "pipe", "ignore"] },
    );
    const display = `:${String((await once(displayProcess.stdout, "data"))[0]).trim()}`;
    const env = { ...process.env, DISPLAY: display };
    const chrome = spawn(
      "google-chrome",
      [
        "--no-sandbox",
        "--no-first-run",
        "--no-default-browser-check",
        "--disable-gpu",
        `--user-data-dir=${directory}`,
        "about:blank",
      ],
      { env, stdio: "ignore", detached: true },
    );
    const command = (args: readonly string[]) =>
      execute("xdotool", [...args], { env, timeout: 10000 });
    const input = new ScreenInput({
      owner: { control: () => "user" },
      dimensions: { width: 800, height: 600 },
      execute: x11Executor(display),
      paste: (text, beforeInput) => pasteUnicode(text, display, beforeInput),
    });
    try {
      const windows = await command([
        "search",
        "--sync",
        "--onlyvisible",
        "--class",
        "google-chrome",
      ]);
      const window = windows.stdout.trim().split("\n")[0];
      if (!window) throw new Error("Chrome window missing");
      await command(["windowfocus", "--sync", window]);
      for (const text of [
        "VM-VIEWER-QA-731 한글입력검증",
        "한글 😀 café é",
        "한글입력".repeat(20),
      ].flatMap((text) => [text, text, text])) {
        await command(["key", "--clearmodifiers", "ctrl+l"]);
        await input.receive(JSON.stringify({ type: "text", text }));
        await command(["key", "--clearmodifiers", "ctrl+a", "ctrl+c"]);
        const actual = await execute("xclip", ["-selection", "clipboard", "-o"], {
          env,
          timeout: 3000,
        });
        expect(actual.stdout).toBe(text);
        console.log(
          JSON.stringify({
            scenario: "chromium_unicode_roundtrip",
            codepoints: Array.from(text).length,
            exact_match: true,
          }),
        );
      }
      const oldDisplay = process.env["DISPLAY"];
      const tools = new ToolExecutor();
      try {
        process.env["DISPLAY"] = display;
        const text = "COMPUTER-TYPE 한글 😀";
        await command(["key", "--clearmodifiers", "ctrl+l"]);
        await tools.run(
          "computer",
          JSON.stringify({ action: "type", x: 0, y: 0, text }),
          new AbortController().signal,
        );
        await command(["key", "--clearmodifiers", "ctrl+a", "ctrl+c"]);
        expect(
          (await execute("xclip", ["-selection", "clipboard", "-o"], { env, timeout: 3000 }))
            .stdout,
        ).toBe(text);
        console.log(
          JSON.stringify({ scenario: "computer_type_unicode_roundtrip", exact_match: true }),
        );
        const readerPath = join(directory, "read-terminal.py");
        const outputPath = join(directory, "terminal-value.txt");
        await Bun.write(
          readerPath,
          `import sys,time
value=sys.stdin.readline().rstrip("\\n")
open(${JSON.stringify(outputPath)},"w").write(value)
print("Terminal input received")
time.sleep(30)
`,
        );
        const terminal = spawn(
          "xfce4-terminal",
          ["--disable-server", "--title=Assistant Unicode QA", "--execute", "python3", readerPath],
          { env, stdio: "ignore" },
        );
        try {
          const found = await command([
            "search",
            "--sync",
            "--onlyvisible",
            "--name",
            "Assistant Unicode QA",
          ]);
          const terminalWindow = found.stdout.trim().split("\n")[0];
          if (!terminalWindow) throw new Error("Terminal window missing");
          await command(["windowfocus", "--sync", terminalWindow]);
          const terminalText = "TERMINAL 한글입력 😀";
          await tools.run(
            "computer",
            JSON.stringify({ action: "type", x: 0, y: 0, text: terminalText }),
            new AbortController().signal,
          );
          await command(["key", "Return"]);
          const deadline = Date.now() + 3000;
          while (!(await Bun.file(outputPath).exists()) && Date.now() < deadline)
            await Bun.sleep(10);
          expect(await Bun.file(outputPath).text()).toBe(terminalText);
          console.log(
            JSON.stringify({ scenario: "xfce_terminal_unicode_roundtrip", exact_match: true }),
          );
        } finally {
          terminal.kill("SIGTERM");
        }
      } finally {
        if (oldDisplay === undefined) delete process.env["DISPLAY"];
        else process.env["DISPLAY"] = oldDisplay;
        await tools.close();
      }
    } finally {
      await input.releaseInputs();
      const browserExit = once(chrome, "exit");
      if (chrome.pid) process.kill(-chrome.pid, "SIGTERM");
      await browserExit;
      const displayExit = once(displayProcess, "exit");
      displayProcess.kill("SIGTERM");
      await displayExit;
      await rm(directory, { recursive: true, force: true });
    }
  },
  30000,
);
