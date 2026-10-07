import { z } from "zod";
import type { Tool } from "../../packages/provider/index.ts";
export const DesktopRequest = z.object({
  code: z
    .string()
    .max(24000)
    .refine((value) => Buffer.byteLength(value, "utf8") <= 24000),
  timeout_ms: z.number().int().min(100).max(15000).default(10000),
});
export const WorkerRequest = DesktopRequest.extend({ id: z.uuid() });
export const WorkerMessage = z.discriminatedUnion("kind", [
  z.object({
    kind: z.literal("held"),
    keys: z.array(z.string().regex(/^[A-Za-z0-9_]{1,32}$/)).max(16),
    buttons: z.array(z.number().int().min(1).max(5)).max(5),
    down: z.boolean(),
  }),
  z.object({
    kind: z.literal("result"),
    id: z.uuid(),
    ok: z.boolean(),
    result: z
      .string()
      .max(16000)
      .refine((value) => Buffer.byteLength(value, "utf8") <= 16000),
    steps: z.number().int().min(0).max(100),
    elapsed_ms: z.number().nonnegative(),
    image: z
      .string()
      .startsWith("data:image/png;base64,")
      .max(12 * 1024 * 1024),
    images: z
      .array(
        z
          .string()
          .startsWith("data:image/png;base64,")
          .max(12 * 1024 * 1024),
      )
      .max(3)
      .optional(),
    width: z.number().int().positive().max(8192),
    height: z.number().int().positive().max(8192),
  }),
]);
export type WorkerMessage = z.infer<typeof WorkerMessage>;
export class DesktopError extends Error {
  constructor(readonly code: string) {
    super(code);
    this.name = "DesktopError";
  }
}
export const computerExecTool: Tool = {
  type: "function",
  name: "computer_exec",
  strict: true,
  description:
    "Preferred fast desktop tool: one short JavaScript async script can perform many actions and loops in a persistent desktop session. Use await desktop.click(x,y,button='left',count=1), move(x,y), drag(x,y,endX,endY), type(text), key('ctrl+l'), scroll(signedSteps), wait(ms<=1000), screenshot(). An actual final screenshot is ALWAYS returned automatically. To observe without acting, use code 'return null;' (zero desktop calls, one final image). Do not call screenshot() solely for the initial or final observation. screenshot() captures and emits up to 3 intermediate frames, returning width/height. Consecutive byte-identical PNG frames are emitted once; changed frames and revisits stay ordered. Intermediate frames plus final screenshot share an 8MiB PNG budget. Mutable state object persists across calls in this task only. Return a JSON value for a short result. Maximum100 desktop API calls,24KB code,15s total. No require/process in script API; this is NOT a security sandbox. Batch adjacent safe actions, then inspect returned pixels; never blindly repeat uncertain effects after cancellation. Unicode replaces VM clipboard.",
  parameters: {
    type: "object",
    properties: {
      code: { type: "string", maxLength: 24000 },
      timeout_ms: { type: "integer", minimum: 100, maximum: 15000 },
    },
    required: ["code", "timeout_ms"],
    additionalProperties: false,
  },
};
