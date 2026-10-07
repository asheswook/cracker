import { z } from 'zod';
import type { Id } from '../types';
import { Persona } from './types';
const OnboardingDraft = z.object({
  persona: Persona.extend({ name: z.string().max(80) }),
  dismissed: z.boolean(),
});
export const onboardingDraftKey = (workspace: Id) => `assistant:onboarding:${workspace}`;
export function readOnboardingDraft(workspace: Id) {
  const stored = localStorage.getItem(onboardingDraftKey(workspace));
  return stored ? OnboardingDraft.parse(JSON.parse(stored)) : null;
}
