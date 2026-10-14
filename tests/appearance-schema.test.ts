import { expect, test } from 'bun:test';
import { AssistantAppearance, defaultAppearance } from '../packages/appearance/schema';
import { characterIconSvg, characterSvg } from '../apps/web/src/appearance/character-svg';

const v1 = { version: 1, shape: 'flower', color: 'coral', eyes: 'oval', eyewear: 'monocle', accessory: 'none' };

test('legacy v1 default maps to a v2 object', () => {
  expect(AssistantAppearance.parse(v1)).toEqual({ version: 2, biscuit: 'butter', color: 'honey', eyes: 'ovals', blush: false, accessory: 'none' });
});

test('legacy v1 mapping covers every shape, color, eyes and accessory', () => {
  const shapes = { circle: 'butter', capsule: 'graham', flower: 'butter', heart: 'ring', diamond: 'wafer', 'rounded-triangle': 'saltine' };
  const colors = { coral: 'honey', pink: 'berry', orchid: 'berry', violet: 'cocoa', blue: 'charcoal', cyan: 'matcha', teal: 'matcha', lime: 'matcha', yellow: 'butter' };
  const eyes = { oval: 'ovals', dots: 'dots', sleepy: 'sleepy', sparkle: 'smile' };
  const accessories = { headphones: 'headphones', bow: 'bow', beanie: 'beret', crown: 'none', none: 'none' };
  for (const [shape, biscuit] of Object.entries(shapes)) expect(String(AssistantAppearance.parse({ ...v1, shape }).biscuit)).toBe(biscuit);
  for (const [color, mapped] of Object.entries(colors)) expect(String(AssistantAppearance.parse({ ...v1, color }).color)).toBe(mapped);
  for (const [eye, mapped] of Object.entries(eyes)) expect(String(AssistantAppearance.parse({ ...v1, eyes: eye }).eyes)).toBe(mapped);
  for (const [accessory, mapped] of Object.entries(accessories)) expect(String(AssistantAppearance.parse({ ...v1, accessory }).accessory)).toBe(mapped);
});

test('v2 is strict: unknown keys, legacy keys and bad values are rejected', () => {
  expect(AssistantAppearance.parse(defaultAppearance)).toEqual(defaultAppearance);
  for (const bad of [{ ...defaultAppearance, extra: 1 }, { ...defaultAppearance, shape: 'flower' }, { ...defaultAppearance, blush: 'true' }, { ...defaultAppearance, version: 3 }, { ...defaultAppearance, biscuit: 'cake' }])
    expect(AssistantAppearance.safeParse(bad).success).toBe(false);
  expect(AssistantAppearance.safeParse({ ...v1, extra: true }).success).toBe(false);
});

test('characterSvg returns a standalone svg with the body colour', () => {
  for (const biscuit of ['saltine', 'butter', 'graham', 'sandwich', 'wafer', 'ring'] as const) {
    const svg = characterSvg({ ...defaultAppearance, biscuit, color: 'cinnamon', blush: true, accessory: 'bow' }, 48);
    expect(svg.startsWith('<svg xmlns="http://www.w3.org/2000/svg"')).toBe(true);
    expect(svg.endsWith('</svg>')).toBe(true);
    expect(svg).toContain('width="48"');
    expect(svg).toContain('#cd8753');
    expect(svg).not.toMatch(/Gradient|<animate/);
  }
  expect(characterSvg({ ...defaultAppearance, color: 'cocoa' })).toContain('color="#f4ece2"');
  expect(characterSvg(defaultAppearance)).toContain('color="#2a211c"');
});

test('characterIconSvg fills the square with the background and keeps the character', () => {
  const svg = characterIconSvg(defaultAppearance, '#3d5470', 1024);
  expect(svg).toContain('<rect width="100" height="100" fill="#3d5470"/>');
  expect(svg).toContain('width="1024"');
  expect(svg).toContain('#eaae60');
});
