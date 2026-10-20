import type { ResponseOutputItem } from "openai/resources/responses/responses";
import type { NativeContextState } from "./native-context.ts";

export type ProviderContinuation = {
  readonly responseId: string;
  readonly output: ResponseOutputItem[];
  readonly nativeContext?: NativeContextState;
};

export type ContinuationReader = () => ProviderContinuation | undefined;
