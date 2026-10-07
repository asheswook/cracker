import { rm } from "node:fs/promises";
import { z } from "zod";
import type { Tool } from "../../packages/provider/index.ts";
import { hasUnicode, pasteUnicode } from "../../packages/screen/text.ts";
import { execute, ShellError } from "./shell.ts";

const actions = [
  "screenshot",
  "click",
  "double_click",
  "right_click",
  "drag",
  "type",
  "key",
  "move",
  "scroll",
] as const;
const Coordinate = z.number().int().min(0).max(32767);
const Computer = z
  .object({
    action: z.enum(actions),
    x: Coordinate,
    y: z.number().int().min(-32767).max(32767),
    text: z.string().max(100000),
    end_x: Coordinate.nullish(),
    end_y: Coordinate.nullish(),
  })
  .superRefine((value, ctx) => {
    if (value.action !== "scroll" && value.y < 0)
      ctx.addIssue({ code: "custom", message: "Y coordinate must be nonnegative" });
    if (value.action === "drag" && (value.end_x == null || value.end_y == null))
      ctx.addIssue({ code: "custom", message: "Drag requires an end position" });
  });

export const computerTool: Tool = {
  type: "function",
  name: "computer",
  strict: true,
  description:
    "Single-action fallback; prefer computer_exec for short multi-action desktop batches with automatic final screenshot. Control the Linux desktop. Screenshot returns actual pixels. Coordinates are screen pixels. Drag moves from x,y to end_x,end_y. Scroll uses y for signed vertical wheel steps (positive down, max 20). key accepts xdotool chords such as ctrl+l. Unused coordinates are 0, text is empty and end coordinates null. Unicode text is pasted using the focused app's shortcut.",
  parameters: {
    type: "object",
    properties: {
      action: { type: "string", enum: [...actions] },
      x: { type: "integer" },
      y: { type: "integer" },
      text: { type: "string" },
      end_x: { type: ["integer", "null"] },
      end_y: { type: ["integer", "null"] },
    },
    required: ["action", "x", "y", "text", "end_x", "end_y"],
    additionalProperties: false,
  },
};

export async function runComputer(
  args: string,
  signal: AbortSignal,
): Promise<{ readonly text: string; readonly image?: string }> {
  signal.throwIfAborted();
  const input = Computer.parse(JSON.parse(args));
  switch (input.action) {
    case "screenshot": {
      const file = `/tmp/assistant-${crypto.randomUUID()}.png`;
      try {
        const result = await execute(["scrot", file], signal);
        return {
          text: result,
          image: `data:image/png;base64,${Buffer.from(await Bun.file(file).arrayBuffer()).toString("base64")}`,
        };
      } finally {
        await rm(file, { force: true });
      }
    }
    case "click":
    case "double_click":
    case "right_click":
      return {
        text: await execute(
          [
            "xdotool",
            "mousemove",
            String(input.x),
            String(input.y),
            "click",
            "--repeat",
            input.action === "double_click" ? "2" : "1",
            "--delay",
            "100",
            input.action === "right_click" ? "3" : "1",
          ],
          signal,
        ),
      };
    case "drag": {
      if (input.end_x == null || input.end_y == null)
        throw new ShellError("drag_endpoint_required");
      await using _releaseMouse = {
        async [Symbol.asyncDispose]() {
          // Cleanup must survive cancellation before control is handed back to the user.
          const cleanup = z
            .object({ exit_code: z.number().nullable() })
            .parse(
              JSON.parse(await execute(["xdotool", "mouseup", "1"], AbortSignal.timeout(3000))),
            );
          if (cleanup.exit_code !== 0) throw new ShellError("drag_release_failed");
        },
      };
      return {
        text: await execute(
          [
            "xdotool",
            "mousemove",
            String(input.x),
            String(input.y),
            "mousedown",
            "1",
            "sleep",
            "0.1",
            "mousemove",
            String(input.end_x),
            String(input.end_y),
            "sleep",
            "0.1",
            "mouseup",
            "1",
          ],
          signal,
        ),
      };
    }
    case "move":
      return {
        text: await execute(["xdotool", "mousemove", String(input.x), String(input.y)], signal),
      };
    case "type":
      if (hasUnicode(input.text)) {
        await pasteUnicode(input.text, z.string().parse(process.env["DISPLAY"]), () =>
          signal.throwIfAborted(),
        );
        return {
          text: JSON.stringify({
            exit_code: 0,
            output: "UTF-8 text pasted; VM clipboard replaced.",
          }),
        };
      }
      return {
        text: await execute(["xdotool", "type", "--clearmodifiers", "--", input.text], signal),
      };
    case "key":
      return { text: await execute(["xdotool", "key", "--clearmodifiers", input.text], signal) };
    case "scroll":
      if (input.y === 0)
        return { text: JSON.stringify({ exit_code: 0, output: "No scrolling requested." }) };
      return {
        text: await execute(
          [
            "xdotool",
            "click",
            "--repeat",
            String(Math.min(20, Math.abs(input.y))),
            "--delay",
            "20",
            input.y > 0 ? "5" : "4",
          ],
          signal,
        ),
      };
    default:
      return unreachable(input.action);
  }
}
function unreachable(value: never): never {
  throw new ShellError(`invalid_computer_action:${String(value)}`);
}
