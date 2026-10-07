import { createInterface } from "node:readline";
import { createContext, Script } from "node:vm";
import { z } from "zod";
import { DesktopApi } from "./desktop-api";
import { DesktopError, type WorkerMessage, WorkerRequest } from "./desktop-protocol";

const directory = z.string().parse(process.env["DESKTOP_SESSION_DIR"]);
const state: Record<string, unknown> = {};
const context = createContext({ state });
function send(value: WorkerMessage) {
  process.stdout.write(`${JSON.stringify(value)}\n`);
}
for await (const line of createInterface({ input: process.stdin, crlfDelay: Infinity })) {
  const request = WorkerRequest.parse(JSON.parse(line));
  const started = performance.now(),
    desktop = new DesktopApi(send, directory);
  context["desktop"] = desktop.api;
  let result = "null",
    ok = true;
  try {
    const value: unknown = await new Script(`(async()=>{\n${request.code}\n})()`).runInContext(
      context,
      { timeout: request.timeout_ms },
    );
    await desktop.drain();
    result = JSON.stringify(value ?? null);
    if (Buffer.byteLength(result, "utf8") > 16000) throw new DesktopError("result_limit");
  } catch (error) {
    ok = false;
    try {
      await desktop.drain();
    } catch (drainError) {
      if (
        !(
          drainError instanceof DesktopError &&
          ["step_limit", "batch_closed", "screenshot_limit"].includes(drainError.code)
        ) &&
        !(drainError instanceof z.ZodError)
      )
        throw drainError;
    }
    result = JSON.stringify({
      error:
        error instanceof DesktopError
          ? error.code
          : error instanceof z.ZodError
            ? "invalid_action"
            : "script_failed",
    });
  }
  const capture = await desktop.capture();
  send({
    kind: "result",
    id: request.id,
    ok,
    result,
    steps: desktop.steps,
    elapsed_ms: performance.now() - started,
    images: desktop.images,
    ...capture,
  });
}
