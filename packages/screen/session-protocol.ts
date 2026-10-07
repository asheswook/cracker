import { z } from "zod";
import { Input } from "./protocol";

export const SCREEN_VERSION = 2;
export const MAX_SCREEN_VIEWERS = 4;
export const INPUT_LEASE_MS = 30000;
export const LeaseEpoch = z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER);
export const ViewerCommand = z.discriminatedUnion("type", [
  z.object({ type: z.literal("screen_visibility"), visible: z.boolean() }),
  z.object({ type: z.literal("input_claim"), command_id: z.uuid() }),
  z.object({ type: z.literal("input_release"), epoch: LeaseEpoch }),
  z.object({ type: z.literal("input_heartbeat"), epoch: LeaseEpoch }),
  z.object({ type: z.literal("input"), epoch: LeaseEpoch, input: Input }),
]);
export type ViewerCommand = z.infer<typeof ViewerCommand>;
export const ViewerEvent = z.discriminatedUnion("type", [
  z.object({ type: z.literal("screen_visibility"), visible: z.boolean() }),
  z.object({ type: z.literal("input_lease"), epoch: LeaseEpoch, held: z.boolean(), command_id: z.uuid().optional() }),
  z.object({ type: z.literal("input_result"), accepted: z.boolean(), code: z.string().max(128).optional() }),
  z.object({ type: z.literal("screen_error"), code: z.string().max(128) }),
]);
export type ViewerEvent = z.infer<typeof ViewerEvent>;
