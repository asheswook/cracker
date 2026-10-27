import { z } from "zod";
export class ScreenError extends Error {
  constructor(readonly code: string) {
    super(code);
    this.name = "ScreenError";
  }
}
export const IceServer = z.object({
  urls: z.string().regex(/^(stun|turn|turns):/),
  username: z.string().optional(),
  credential: z.string().optional(),
});
export const IceCandidate = z.object({
  candidate: z.string().max(8192),
  sdpMid: z.string().nullable().optional(),
  sdpMLineIndex: z.number().int().min(0).nullable().optional(),
});
const ViewerScope = { viewer_id: z.uuid().optional(), version: z.union([z.literal(1), z.literal(2)]).optional() };
export const Signal = z.discriminatedUnion("type", [
  z.object({ type: z.literal("offer"), sdp: z.string().min(1).max(131072), visible: z.boolean().optional(), ...ViewerScope }),
  z.object({ type: z.literal("ice"), candidate: IceCandidate.nullable(), ...ViewerScope }),
  z.object({ type: z.literal("peer_waiting"), ...ViewerScope }),
  z.object({ type: z.literal("peer_left"), ...ViewerScope }),
  z.object({ type: z.literal("peer_ready"), ...ViewerScope }),
]);
export type Signal = z.infer<typeof Signal>;
export const Dimensions = z.object({
  width: z.number().int().min(2).max(8192),
  height: z.number().int().min(2).max(8192),
});
export type Dimensions = z.infer<typeof Dimensions>;
export const Input = z.discriminatedUnion("type", [
  z.object({
    type: z.literal("pointer_relative"),
    dx: z.number().finite().min(-1).max(1),
    dy: z.number().finite().min(-1).max(1),
  }),
  z.object({
    type: z.literal("pointer_button"),
    button: z.union([z.literal(0), z.literal(1), z.literal(2)]),
    action: z.enum(["down", "up"]),
  }),
  z.object({
    type: z.literal("pointer"),
    x: z.number().min(0).max(1),
    y: z.number().min(0).max(1),
    button: z.union([z.literal(0), z.literal(1), z.literal(2)]).default(0),
    action: z.enum(["move", "down", "up"]),
  }),
  z.object({ type: z.literal("scroll"), dy: z.number().int().min(-20).max(20) }),
  z.object({
    type: z.literal("key"),
    key: z
      .string()
      .regex(
        /^(?:[A-Za-z0-9]|F(?:[1-9]|1[0-9]|2[0-4])|Enter|Tab|Escape|BackSpace|Delete|Left|Right|Up|Down|Home|End|Page_Up|Page_Down|space|minus|equal|bracketleft|bracketright|backslash|semicolon|apostrophe|comma|period|slash|grave|Hangul|Control_L|Shift_L|Alt_L|Super_L)$/,
      ),
    action: z.enum(["down", "up"]),
  }),
  z.object({ type: z.literal("text"), text: z.string().min(1).max(4096) }),
]);
export type Input = z.infer<typeof Input>;
export type ControlOwner = { readonly control: () => "agent" | "user" };
