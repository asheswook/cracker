import { execFile, spawn } from "node:child_process";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import { z } from "zod";
import { ScreenError } from "./protocol";

const execute = promisify(execFile);
let pending: Promise<void> = Promise.resolve();
export function hasUnicode(text: string): boolean {
  return Array.from(text).some((character) => character.charCodeAt(0) > 127);
}
export function pasteUnicode(
  text: string,
  display: string,
  beforeInput: () => void,
): Promise<void> {
  const next = pending.then(async () => {
    z.string()
      .regex(/^:\d+(?:\.\d+)?$/)
      .parse(display);
    z.string().min(1).max(100000).parse(text);
    beforeInput();
    const env = {
      ...Object.fromEntries(
        ["PATH", "HOME", "XAUTHORITY", "LANG", "LC_ALL"].flatMap((name) => {
          const value = process.env[name];
          return value === undefined ? [] : [[name, value]];
        }),
      ),
      DISPLAY: display,
    };
    const focus = async () => {
      try {
        const result = await execute("xdotool", ["getwindowfocus"], {
          env,
          timeout: 1000,
          maxBuffer: 1024,
        });
        return z
          .string()
          .regex(/^[0-9]+$/)
          .parse(result.stdout.trim());
      } catch {
        throw new ScreenError("paste_target_unavailable");
      }
    };
    const clipboardOwner = async () => {
      try {
        const result = await execute(
          "python3",
          [fileURLToPath(new URL("./clipboard-owner.py", import.meta.url))],
          { env, timeout: 1000, maxBuffer: 1024 },
        );
        return z
          .string()
          .regex(/^[0-9]+$/)
          .parse(result.stdout.trim());
      } catch {
        throw new ScreenError("clipboard_owner_unavailable");
      }
    };
    const previousOwner = await clipboardOwner();
    const target = await focus();
    let pasteKey = "ctrl+v";
    try {
      const result = await execute("xprop", ["-id", target, "WM_CLASS"], {
        env,
        timeout: 1000,
        maxBuffer: 4096,
      });
      if (!/WM_CLASS\(STRING\) = "[^"\n]+", "[^"\n]+"/.test(result.stdout))
        throw new ScreenError("paste_target_unavailable");
      if (/"[Xx]fce4-terminal"/.test(result.stdout)) pasteKey = "ctrl+shift+v";
    } catch {
      throw new ScreenError("paste_target_unavailable");
    }
    beforeInput();
    await new Promise<void>((resolve, reject) => {
      const child = spawn("xclip", ["-selection", "clipboard", "-in", "-target", "UTF8_STRING"], {
        env,
        stdio: ["pipe", "ignore", "ignore"],
      });
      const timer = setTimeout(() => {
        child.kill("SIGKILL");
        reject(new ScreenError("clipboard_timeout"));
      }, 3000);
      child.once("error", () => {
        clearTimeout(timer);
        reject(new ScreenError("clipboard_unavailable"));
      });
      child.once("exit", (code) => {
        clearTimeout(timer);
        if (code === 0) resolve();
        else reject(new ScreenError("clipboard_failed"));
      });
      child.stdin.on("error", () => reject(new ScreenError("clipboard_write_failed")));
      child.stdin.end(text, "utf8");
    });
    const owner = await clipboardOwner();
    if (owner === "0" || owner === previousOwner)
      throw new ScreenError("clipboard_owner_unconfirmed");
    beforeInput();
    if ((await focus()) !== target) throw new ScreenError("paste_focus_changed");
    if ((await clipboardOwner()) !== owner) throw new ScreenError("clipboard_owner_changed");
    beforeInput();
    try {
      await execute("xdotool", ["key", "--clearmodifiers", pasteKey], {
        env,
        timeout: 3000,
        maxBuffer: 8192,
      });
    } catch {
      throw new ScreenError("clipboard_paste_failed");
    }
  });
  pending = next.catch(() => undefined);
  return next;
}
