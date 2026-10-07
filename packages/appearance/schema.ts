import { z } from 'zod';

export const AssistantAppearance = z.object({
  version: z.literal(1),
  shape: z.enum(['circle', 'capsule', 'flower', 'heart', 'diamond', 'rounded-triangle']),
  color: z.enum(['coral', 'pink', 'orchid', 'violet', 'blue', 'cyan', 'teal', 'lime', 'yellow']),
  eyes: z.enum(['oval', 'dots', 'sleepy', 'sparkle']),
  eyewear: z.enum(['none', 'monocle', 'round', 'sunglasses']),
  accessory: z.enum(['none', 'headphones', 'bow', 'beanie', 'crown']),
}).strict();
export type AssistantAppearance = z.infer<typeof AssistantAppearance>;

export const defaultAppearance = {
  version: 1, shape: 'flower', color: 'coral', eyes: 'oval', eyewear: 'monocle', accessory: 'none',
} as const satisfies AssistantAppearance;

export const AppearanceSettings = z.object({ appearance: AssistantAppearance, revision: z.uuid() }).strict();
export type AppearanceSettings = z.infer<typeof AppearanceSettings>;
export const AppearanceUpdate = z.object({ appearance: AssistantAppearance, expected_revision: z.uuid() }).strict();
export const AppearanceConflict = z.object({
  error: z.object({ code: z.literal('appearance_conflict'), message: z.string() }).strict(),
  current: AppearanceSettings,
}).strict();
