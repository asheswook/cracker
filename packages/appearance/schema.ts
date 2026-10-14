import { z } from 'zod';

const AppearanceV2 = z.object({
  version: z.literal(2),
  biscuit: z.enum(['saltine', 'butter', 'graham', 'sandwich', 'wafer', 'ring']),
  color: z.enum(['wheat', 'butter', 'honey', 'cinnamon', 'cocoa', 'matcha', 'berry', 'charcoal']),
  eyes: z.enum(['dots', 'ovals', 'sleepy', 'smile']),
  blush: z.boolean(),
  accessory: z.enum(['none', 'headphones', 'beret', 'bow']),
}).strict();

const AppearanceV1 = z.object({
  version: z.literal(1),
  shape: z.enum(['circle', 'capsule', 'flower', 'heart', 'diamond', 'rounded-triangle']),
  color: z.enum(['coral', 'pink', 'orchid', 'violet', 'blue', 'cyan', 'teal', 'lime', 'yellow']),
  eyes: z.enum(['oval', 'dots', 'sleepy', 'sparkle']),
  eyewear: z.enum(['none', 'monocle', 'round', 'sunglasses']),
  accessory: z.enum(['none', 'headphones', 'bow', 'beanie', 'crown']),
}).strict();

const legacyBiscuit = { circle: 'butter', capsule: 'graham', flower: 'butter', heart: 'ring', diamond: 'wafer', 'rounded-triangle': 'saltine' } as const;
const legacyColor = { coral: 'honey', pink: 'berry', orchid: 'berry', violet: 'cocoa', blue: 'charcoal', cyan: 'matcha', teal: 'matcha', lime: 'matcha', yellow: 'butter' } as const;
const legacyEyes = { oval: 'ovals', dots: 'dots', sleepy: 'sleepy', sparkle: 'smile' } as const;
const legacyAccessory = { none: 'none', headphones: 'headphones', bow: 'bow', beanie: 'beret', crown: 'none' } as const;

export const AssistantAppearance = z.preprocess((input): unknown => {
  const legacy = AppearanceV1.safeParse(input);
  if (!legacy.success) return input;
  const v = legacy.data;
  return { version: 2, biscuit: legacyBiscuit[v.shape], color: legacyColor[v.color], eyes: legacyEyes[v.eyes], blush: false, accessory: legacyAccessory[v.accessory] };
}, AppearanceV2);
export type AssistantAppearance = z.infer<typeof AppearanceV2>;

export const defaultAppearance = {
  version: 2, biscuit: 'saltine', color: 'honey', eyes: 'dots', blush: false, accessory: 'none',
} as const satisfies AssistantAppearance;

export const AppearanceSettings = z.object({ appearance: AssistantAppearance, revision: z.uuid() }).strict();
export type AppearanceSettings = z.infer<typeof AppearanceSettings>;
export const AppearanceUpdate = z.object({ appearance: AssistantAppearance, expected_revision: z.uuid() }).strict();
export const AppearanceConflict = z.object({
  error: z.object({ code: z.literal('appearance_conflict'), message: z.string() }).strict(),
  current: AppearanceSettings,
}).strict();

export const defaultAssistantName = '크래커';
export const isDefaultAssistantName = (name: string) => name === defaultAssistantName || name === 'Assistant';
