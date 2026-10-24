import { ModelSelection } from '../../packages/models/schema.ts';

/** Small auxiliary models used by the knowledge tree. */
export const AUX_CLAUDE_MODEL = 'claude-haiku-5-5';
export const AUX_OPENAI_MODEL = 'gpt-6-luna';
export const AUX_OPENAI_EFFORT = 'medium';
/** Default selection time limit per family: Claude family 5 s, OpenAI family 8 s. */
export const AUX_CLAUDE_TIMEOUT_MS = 5000;
export const AUX_OPENAI_TIMEOUT_MS = 8000;

/**
 * Same provider/credential as the run's model, but a small model of the same family:
 * a `claude*` model (anthropic, or a subscription claude-*) → claude-haiku-5-5; anything else → gpt-6-luna with medium reasoning.
 */
export function auxiliarySelection(base: ModelSelection): ModelSelection {
  const claude = base.model.startsWith('claude');
  return ModelSelection.parse(claude
    ? { provider: base.provider, model: AUX_CLAUDE_MODEL, reasoning_effort: null }
    : { provider: base.provider, model: AUX_OPENAI_MODEL, reasoning_effort: AUX_OPENAI_EFFORT });
}
export const auxiliaryTimeoutMs = (model: string, override?: number) => override ?? (model.startsWith('claude') ? AUX_CLAUDE_TIMEOUT_MS : AUX_OPENAI_TIMEOUT_MS);
