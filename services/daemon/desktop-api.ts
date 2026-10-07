import { execFile } from "node:child_process";
import { rm } from "node:fs/promises";
import { join } from "node:path";
import { promisify } from "node:util";
import { z } from "zod";
import { hasUnicode, pasteUnicode } from "../../packages/screen/text.ts";
import { DesktopError, type WorkerMessage } from "./desktop-protocol";

const execute = promisify(execFile);
const Point = z.number().int().min(0).max(32767);
export class DesktopApi {
  private tail: Promise<void> = Promise.resolve();
  private failure: unknown;
  private open = true;
  steps = 0;
  private capturedBytes = 0;
  readonly images: string[] = [];
  constructor(
    private readonly send: (value: WorkerMessage) => void,
    private readonly directory: string,
  ) {}
  private enqueue<T>(operation: () => Promise<T>): Promise<T> {
    if (!this.open) return Promise.reject(new DesktopError("batch_closed"));
    if (++this.steps > 100) {
      this.steps = 100;
      this.failure = new DesktopError("step_limit");
      return Promise.reject(this.failure);
    }
    const next = this.tail.then(async () => {
      if (this.failure) throw this.failure;
      return operation();
    });
    this.tail = next.then(
      () => undefined,
      (error) => {
        this.failure = error;
      },
    );
    return next;
  }
  private async command(args: readonly string[]) {
    try {
      await execute("xdotool", [...args], { timeout: 3000, maxBuffer: 8192 });
    } catch {
      throw new DesktopError("desktop_command_failed");
    }
  }
  async drain() {
    this.open = false;
    await this.tail;
    if (this.failure) throw this.failure;
  }
  readonly api = {
    move: (x: unknown, y: unknown) =>
      this.enqueue(() =>
        this.command(["mousemove", String(Point.parse(x)), String(Point.parse(y))]),
      ),
    click: (x: unknown, y: unknown, button: unknown = "left", count: unknown = 1) =>
      this.enqueue(async () => {
        const name = z.enum(["left", "middle", "right"]).parse(button),
          repeats = z.number().int().min(1).max(3).parse(count);
        const code = name === "left" ? 1 : name === "middle" ? 2 : 3;
        this.send({ kind: "held", keys: [], buttons: [code], down: true });
        try {
          await this.command([
            "mousemove",
            String(Point.parse(x)),
            String(Point.parse(y)),
            "click",
            "--repeat",
            String(repeats),
            "--delay",
            "100",
            String(code),
          ]);
        } finally {
          await this.command(["mouseup", String(code)]);
          this.send({ kind: "held", keys: [], buttons: [code], down: false });
        }
      }),
    drag: (x: unknown, y: unknown, endX: unknown, endY: unknown) =>
      this.enqueue(async () => {
        const points = [x, y, endX, endY].map((value) => Point.parse(value));
        const [startX, startY, finishX, finishY] = points;
        this.send({ kind: "held", keys: [], buttons: [1], down: true });
        try {
          await this.command([
            "mousemove",
            String(startX),
            String(startY),
            "mousedown",
            "1",
            "sleep",
            "0.05",
            "mousemove",
            String(finishX),
            String(finishY),
            "sleep",
            "0.05",
            "mouseup",
            "1",
          ]);
        } finally {
          await this.command(["mouseup", "1"]);
          this.send({ kind: "held", keys: [], buttons: [1], down: false });
        }
      }),
    key: (value: unknown) =>
      this.enqueue(async () => {
        const chord = z
          .string()
          .regex(/^[A-Za-z0-9_]+(?:\+[A-Za-z0-9_]+){0,7}$/)
          .max(128)
          .parse(value);
        const keys = chord.split("+").map((key) => z.string().max(32).parse(key));
        this.send({ kind: "held", keys, buttons: [], down: true });
        try {
          await this.command(["key", "--clearmodifiers", chord]);
        } finally {
          await this.command(["keyup", ...keys]);
          this.send({ kind: "held", keys, buttons: [], down: false });
        }
      }),
    type: (value: unknown) =>
      this.enqueue(async () => {
        const text = z.string().min(1).max(4096).parse(value);
        if (hasUnicode(text))
          await pasteUnicode(text, z.string().parse(process.env["DISPLAY"]), () => {});
        else await this.command(["type", "--clearmodifiers", "--delay", "0", "--", text]);
      }),
    scroll: (value: unknown) =>
      this.enqueue(async () => {
        const steps = z.number().int().min(-20).max(20).parse(value);
        if (steps !== 0)
          await this.command([
            "click",
            "--repeat",
            String(Math.abs(steps)),
            "--delay",
            "15",
            steps > 0 ? "5" : "4",
          ]);
      }),
    wait: (value: unknown) =>
      this.enqueue(async () => {
        await Bun.sleep(z.number().int().min(0).max(1000).parse(value));
      }),
    screenshot: () =>
      this.enqueue(async () => {
        if (this.images.length >= 3) throw new DesktopError("screenshot_limit");
        const image = await this.capture();
        this.images.push(image.image);
        return { width: image.width, height: image.height };
      }),
  };
  async capture() {
    const path = join(this.directory, `screen-${crypto.randomUUID()}.png`);
    try {
      await execute("scrot", [path], { timeout: 3000, maxBuffer: 8192 });
      const file = Bun.file(path);
      if (file.size + this.capturedBytes > 8 * 1024 * 1024)
        throw new DesktopError("screenshot_too_large");
      const bytes = Buffer.from(await file.arrayBuffer());
      this.capturedBytes += bytes.length;
      if (
        bytes.length < 24 ||
        !bytes.subarray(0, 8).equals(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]))
      )
        throw new DesktopError("invalid_screenshot");
      return {
        image: `data:image/png;base64,${bytes.toString("base64")}`,
        width: bytes.readUInt32BE(16),
        height: bytes.readUInt32BE(20),
      };
    } finally {
      await rm(path, { force: true });
    }
  }
}
