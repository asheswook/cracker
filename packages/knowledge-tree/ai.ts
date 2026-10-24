/** Workers-AI facing helpers for the knowledge tree routes. The model call itself is injected so tests can fake it. */
import { z } from 'zod';
import { DomainError } from '../protocol';
import { CONTEXT_EMBEDDING_MODEL, encodeContext } from '../context/recall-types.ts';
import { clefBody } from './core.ts';
import { CLEF_TIMEOUT_MS, type ClefRaw, type ClefRequest } from './schema.ts';

export type TreeEmbed = (texts: readonly string[], signal: AbortSignal) => Promise<unknown>;
export type TreeClef = (input: Record<string, unknown>, signal: AbortSignal) => Promise<unknown>;
export type KnowledgeTreeAi = { readonly embed?: TreeEmbed; readonly clef?: TreeClef };

const ClefAnswer = z.object({ answers: z.object({ context: z.object({
  type: z.literal('choice'), choice: z.string(), confidence: z.number().min(0).max(1), probabilities: z.record(z.string(), z.number().min(0).max(1)),
}) }) });

export { CONTEXT_EMBEDDING_MODEL };
export async function embedTexts(ai: KnowledgeTreeAi | undefined, texts: readonly string[]): Promise<{ vectors: number[][]; ms: number }> {
  const embed = ai?.embed;
  if (!embed) throw new DomainError('context_embedding_unavailable', 'Context search unavailable', 503);
  const start = performance.now();
  try { return { vectors: await encodeContext(embed, texts), ms: performance.now() - start }; }
  catch (error) {
    if (error instanceof DomainError) throw error;
    throw new DomainError('context_embedding_unavailable', 'Context search unavailable', 503);
  }
}
/** Runs Clef once with the 8 s timeout and returns its RAW answer (the 0.85 routing gate of packages/context/clef.ts is NOT applied). */
export async function rawClef(ai: KnowledgeTreeAi | undefined, request: ClefRequest): Promise<ClefRaw> {
  const run = ai?.clef;
  if (!run) throw new DomainError('clef_unavailable', 'Classifier unavailable', 503);
  const body = clefBody(request), start = performance.now();
  let value: unknown;
  try { value = await run(body, AbortSignal.timeout(CLEF_TIMEOUT_MS)); }
  catch { throw new DomainError('clef_unavailable', 'Classifier unavailable', 503); }
  const ms = performance.now() - start, parsed = ClefAnswer.safeParse(value);
  if (!parsed.success) throw new DomainError('clef_unavailable', 'Classifier returned an invalid answer', 503);
  const answer = parsed.data.answers.context, options = new Set(['uncertain', ...request.candidates.map(c => c.option)]);
  if (!options.has(answer.choice) || Object.keys(answer.probabilities).some(k => !options.has(k))) throw new DomainError('clef_unavailable', 'Classifier returned an invalid choice', 503);
  return { choice: answer.choice, confidence: answer.confidence, probabilities: answer.probabilities, ms };
}
