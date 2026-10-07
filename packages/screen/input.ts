import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { type ControlOwner, type Dimensions, Input, ScreenError } from "./protocol";
import { hasUnicode } from "./text";

const execute = promisify(execFile);
export type InputExecutor = (args: readonly string[]) => Promise<void>;
export function x11Executor(display: string): InputExecutor {
  return async (args) => {
    await execute("xdotool", [...args], {
      env: { ...process.env, DISPLAY: display },
      timeout: 3000,
      maxBuffer: 8192,
    });
  };
}
export class ScreenInput {
  private pending = 0;
  private tail: Promise<void> = Promise.resolve();
  private readonly heldKeys = new Set<string>();
  private readonly heldButtons = new Set<number>();
  private relativeRemainder = { x: 0, y: 0 };
  private permitted: (() => boolean) | undefined;
  constructor(
    private readonly config: {
      readonly owner: ControlOwner;
      readonly dimensions: Dimensions;
      readonly execute: InputExecutor;
      readonly paste?: (text: string, beforeInput: () => void) => Promise<void>;
    },
  ) {}
  async receive(data: string, permitted?: () => boolean): Promise<void> {
    if (data.length > 16384) throw new ScreenError("input_too_large");
    const input = Input.parse(JSON.parse(data));
    if (this.pending >= 64) throw new ScreenError("input_queue_full");
    this.pending++;
    const next = this.tail.then(async () => {
      this.permitted = permitted;
      try { this.assertOwner(); await this.apply(input); }
      finally { this.permitted = undefined; }
    });
    this.tail = next.then(
      () => undefined,
      () => undefined,
    );
    try {
      await next;
    } finally {
      this.pending--;
    }
  }
  private assertOwner(): void {
    if (this.config.owner.control() !== "user") throw new ScreenError("user_control_required");
    if (this.permitted && !this.permitted()) throw new ScreenError("input_lease_required");
  }
  private async command(args: readonly string[]): Promise<void> {
    this.assertOwner();
    await this.config.execute(args);
  }
  private async apply(input: Input): Promise<void> {
    switch (input.type) {
      case "pointer_relative": {
        this.assertOwner();
        const x = input.dx * (this.config.dimensions.width - 1) + this.relativeRemainder.x;
        const y = input.dy * (this.config.dimensions.height - 1) + this.relativeRemainder.y;
        const roundedX = Math.round(x), roundedY = Math.round(y);
        if (roundedX || roundedY)
          await this.command(["mousemove_relative", "--", String(roundedX), String(roundedY)]);
        this.relativeRemainder = { x: x - roundedX, y: y - roundedY };
        break;
      }
      case "pointer_button": {
        this.assertOwner();
        const button = input.button + 1;
        if (input.action === "down") this.heldButtons.add(button);
        await this.command([input.action === "down" ? "mousedown" : "mouseup", String(button)]);
        if (input.action === "up") this.heldButtons.delete(button);
        break;
      }
      case "pointer": {
        this.relativeRemainder = { x: 0, y: 0 };
        const x = Math.round(input.x * (this.config.dimensions.width - 1)),
          y = Math.round(input.y * (this.config.dimensions.height - 1));
        await this.command(["mousemove", String(x), String(y)]);
        const button = input.button + 1;
        switch (input.action) {
          case "move":
            break;
          case "down":
            this.heldButtons.add(button);
            await this.command(["mousedown", String(button)]);
            break;
          case "up":
            await this.command(["mouseup", String(button)]);
            this.heldButtons.delete(button);
            break;
          default:
            unreachable(input);
        }
        break;
      }
      case "scroll":
        if (input.dy !== 0)
          await this.command([
            "click",
            "--repeat",
            String(Math.abs(input.dy)),
            "--delay",
            "0",
            input.dy > 0 ? "5" : "4",
          ]);
        break;
      case "key": {
        const key = input.key === "Enter" ? "Return" : input.key;
        if (input.action === "down") this.heldKeys.add(key);
        await this.command([input.action === "down" ? "keydown" : "keyup", key]);
        if (input.action === "up") this.heldKeys.delete(key);
        break;
      }
      case "text": {
        if (hasUnicode(input.text) || input.text.length > 1 || /[\r\n\t]/.test(input.text)) {
          if (!this.config.paste) throw new ScreenError("unicode_paste_unavailable");
          await this.config.paste(input.text, () => {
            this.assertOwner();
          });
        } else await this.command(["type", "--clearmodifiers", "--delay", "0", "--", input.text]);
        break;
      }
      default:
        unreachable(input);
    }
  }
  async releaseInputs(): Promise<void> {
    await this.tail;
    for (const key of this.heldKeys) await this.config.execute(["keyup", key]);
    for (const button of this.heldButtons) await this.config.execute(["mouseup", String(button)]);
    this.heldKeys.clear();
    this.heldButtons.clear();
    this.relativeRemainder = { x: 0, y: 0 };
  }
}
function unreachable(value: never): never {
  throw new ScreenError(`unsupported_input:${String(value)}`);
}
