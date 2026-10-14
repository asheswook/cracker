import { z } from "zod";
import type { Response, ResponseInputItem, Tool } from "openai/resources/responses/responses";
import type { ProviderResponseObserver } from "./stream.ts";
import type { RetryBudget } from './retry.ts';

export const NativeText = z.object({ type: z.literal("text"), text: z.string() });
export const SignedSummary = z
  .object({
    type: z.literal("compaction"),
    content: z.string().min(1),
    signature: z.string().min(1),
  })
  .catchall(z.unknown());
export const NativeAssistantBlocks = z.array(
  z.discriminatedUnion("type", [
    z.object({ type: z.literal("text"), text: z.string() }).catchall(z.unknown()),
    z
      .object({ type: z.literal("thinking"), thinking: z.string(), signature: z.string().min(1) })
      .catchall(z.unknown()),
    z
      .object({ type: z.literal("redacted_thinking"), data: z.string().min(1) })
      .catchall(z.unknown()),
    z
      .object({
        type: z.literal("tool_use"),
        id: z.string(),
        name: z.string(),
        input: z.record(z.string(), z.unknown()),
      })
      .catchall(z.unknown()),
  ]),
);
const NativeReply = z.object({
  from: z.number().int().nonnegative(),
  to: z.number().int().positive(),
  hash: z.string().length(64),
  content: NativeAssistantBlocks,
});
export const NativeContextState = z.object({
  version: z.literal(1),
  provider: z.literal("anthropic"),
  runId: z.string().min(1),
  model: z.string().min(1),
  system: z.array(NativeText),
  toolsHash: z.string().length(64),
  compactedThrough: z.number().int().nonnegative(),
  archive: z.object({ through: z.number().int().positive(), hash: z.string().length(64) }).optional(),
  summary: SignedSummary.optional(),
  pendingSystem: z.array(NativeText),
  reply: NativeReply.optional(),
  frames: z.array(
    z.object({
      from: z.number().int().nonnegative(),
      to: z.number().int().positive(),
      hash: z.string().length(64),
      initial: z.boolean(),
      clock: z.string(),
      extraSystem: z.array(NativeText),
      reply: NativeReply.optional(),
    }),
  ),
});
export type NativeContextState = z.infer<typeof NativeContextState>;
export type NativeContextCapability =
  | {
      readonly kind: "supported";
      readonly model: string;
      readonly maxInputTokens: number;
      readonly maxOutputTokens: number;
      readonly outputTokenBudget: number;
    }
  | {
      readonly kind: "unsupported";
      readonly reason:
        | "inline_system_unverified"
        | "summarize_unsupported"
        | "model_identity_mismatch"
        | "capability_unavailable";
    };
export type NativeContextRequest = {
  readonly budget?: RetryBudget;
  readonly runId: string;
  readonly input: ResponseInputItem[];
  readonly tools: Tool[];
  readonly state?: NativeContextState;
  readonly signal: AbortSignal;
};
export interface NativeContext {
  capability(signal: AbortSignal): Promise<NativeContextCapability>;
  measure(request: NativeContextRequest & { readonly clock: string }): Promise<number>;
  respond(
    request: NativeContextRequest & {
      readonly clock: string;
      readonly observer?: ProviderResponseObserver;
    },
  ): Promise<{ readonly response: Response; readonly state: NativeContextState }>;
  compact(
    request: NativeContextRequest & { readonly state: NativeContextState },
  ): Promise<NativeContextState | undefined>;
}
export class NativeContextError extends Error {
  constructor(
    readonly code:
      | "prefix_changed"
      | "model_changed"
      | "run_changed"
      | "invalid_frame"
      | "unsupported_capability"
      | "invalid_summary"
      | "invalid_token_count"
      | "input_budget_exceeded"
      | "uncountable_media"
      | "request_body_too_large",
  ) {
    super(`Claude native context: ${code}`);
    this.name = "NativeContextError";
  }
}
