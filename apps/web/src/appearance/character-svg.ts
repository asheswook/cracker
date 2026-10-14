import type { AssistantAppearance } from './types';

type Color = AssistantAppearance['color'];
type Biscuit = AssistantAppearance['biscuit'];

export const characterPalette = {
  wheat: ['#ecd3a6', '#cfa970'], butter: ['#f4dc93', '#d8b65c'], honey: ['#eaae60', '#c08139'], cinnamon: ['#cd8753', '#9f5f33'],
  cocoa: ['#7d5443', '#5a3a2d'], matcha: ['#adc48e', '#819b66'], berry: ['#e6a7ab', '#c27a80'], charcoal: ['#5e5b56', '#403e3a'],
} as const satisfies Record<Color, readonly [string, string]>;

const darkBodies: ReadonlySet<Color> = new Set<Color>(['cocoa', 'charcoal']);
const INK = '#2a211c', INK_LIGHT = '#f4ece2', CREAM = '#f7f0e4', ACCENT = '#a8463f';
export const inkFor = (color: Color) => darkBodies.has(color) ? INK_LIGHT : INK;

const n = (v: number) => String(Math.round(v * 10) / 10);
const scallop = (() => {
  const pts: string[] = [];
  for (let i = 0; i < 120; i++) {
    const t = i / 120 * Math.PI * 2, r = 33 + 2.2 * Math.cos(10 * t);
    pts.push(`${n(50 + r * Math.cos(t))} ${n(50 + r * Math.sin(t))}`);
  }
  return `M${pts.join('L')}Z`;
})();
const rrect = (x: number, y: number, w: number, h: number, r: number) =>
  `M${x + r} ${y}H${x + w - r}A${r} ${r} 0 0 1 ${x + w} ${y + r}V${y + h - r}A${r} ${r} 0 0 1 ${x + w - r} ${y + h}H${x + r}A${r} ${r} 0 0 1 ${x} ${y + h - r}V${y + r}A${r} ${r} 0 0 1 ${x + r} ${y}Z`;
const ringPath = 'M50 16a34 34 0 1 1 0 68 34 34 0 0 1 0-68zM50 42a8 8 0 1 0 0 16 8 8 0 0 0 0-16z';

interface Body { readonly path: string; readonly eyeY: number; readonly spread: number; readonly mark: (base: string) => string }
const bodies: Record<Biscuit, Body> = {
  saltine: { path: rrect(15, 15, 70, 68, 17), eyeY: 54, spread: 0,
    mark: b => `<g fill="${b}" opacity=".55"><circle cx="30" cy="29" r="2.6"/><circle cx="70" cy="29" r="2.6"/><circle cx="50" cy="29" r="2.6"/></g>` },
  butter: { path: scallop, eyeY: 53, spread: 0, mark: () => '' },
  graham: { path: rrect(9, 22, 82, 56, 13), eyeY: 54, spread: 2,
    mark: b => `<path d="M50 30v40" stroke="${b}" stroke-width="2.4" stroke-linecap="round" stroke-dasharray=".1 6.5" opacity=".6"/>` },
  sandwich: { path: rrect(14, 15, 72, 69, 16), eyeY: 47, spread: 0,
    mark: () => `<path d="M14 61H86V65H14Z" class="character-cream" fill="${CREAM}"/>` },
  wafer: { path: rrect(16, 15, 68, 68, 12), eyeY: 54, spread: 0,
    mark: b => `<path d="M16 34H84M16 66H84" stroke="${b}" stroke-width="2" opacity=".35"/>` },
  ring: { path: ringPath, eyeY: 41, spread: 4, mark: () => '' },
};

function eyes(kind: AssistantAppearance['eyes'], y: number, s: number): string {
  const l = 35 - s, r = 65 + s;
  const arc = (x: number, d: string) => `M${x - 5} ${d}`;
  switch (kind) {
    case 'dots': return `<circle cx="${l}" cy="${y}" r="4"/><circle cx="${r}" cy="${y}" r="4"/>`;
    case 'ovals': return `<ellipse cx="${l}" cy="${y}" rx="3.6" ry="5.4"/><ellipse cx="${r}" cy="${y}" rx="3.6" ry="5.4"/>`;
    case 'sleepy': return `<g fill="none" stroke="currentColor" stroke-width="3.2" stroke-linecap="round"><path d="${arc(l, `${y - 1}q5 4.5 10 0`)}${arc(r, `${y - 1}q5 4.5 10 0`)}"/></g>`;
    case 'smile': return `<g fill="none" stroke="currentColor" stroke-width="3.2" stroke-linecap="round" stroke-linejoin="round"><path d="${arc(l, `${y + 2}q5-6.5 10 0`)}${arc(r, `${y + 2}q5-6.5 10 0`)}"/></g>`;
  }
  return kind satisfies never;
}

function accessory(kind: AssistantAppearance['accessory'], dark: boolean): string {
  const band = dark ? '#e9dccb' : '#3d3b38';
  switch (kind) {
    case 'none': return '';
    case 'headphones': return `<g fill="${band}"><path d="M15 54V47a35 35 0 0 1 70 0v7" fill="none" stroke="${band}" stroke-width="5" stroke-linecap="round"/><rect x="7" y="46" width="13" height="22" rx="6.5"/><rect x="80" y="46" width="13" height="22" rx="6.5"/></g>`;
    case 'beret': return `<g fill="${ACCENT}"><ellipse cx="48" cy="16" rx="27" ry="10" transform="rotate(-8 48 16)"/><rect x="46" y="3" width="5" height="7" rx="2.5"/></g>`;
    case 'bow': return `<g fill="${ACCENT}"><path d="M70 16c-6-8-15-9-15 0s9 8 15 0c6 8 15 9 15 0s-9-8-15 0z"/><circle cx="70" cy="16" r="3.6"/></g>`;
  }
  return kind satisfies never;
}

export interface CharacterParts { readonly body: string; readonly face: string; readonly accessory: string; readonly extras: string }
export function characterParts(a: AssistantAppearance): CharacterParts {
  const [fill, base] = characterPalette[a.color], b = bodies[a.biscuit], y = b.eyeY, dark = darkBodies.has(a.color);
  const even = a.biscuit === 'ring' ? ' fill-rule="evenodd"' : '';
  const body = `<path d="${b.path}"${even} fill="${base}" transform="translate(0 3.5)"/><path d="${b.path}"${even} fill="${fill}"/>` + b.mark(base);
  const bx = 35 - b.spread - 6, by = y + 9;
  const blush = a.blush ? `<g fill="${base}" opacity=".55"><ellipse cx="${bx}" cy="${by}" rx="5.5" ry="3.2"/><ellipse cx="${100 - bx}" cy="${by}" rx="5.5" ry="3.2"/></g>` : '';
  const mouth = a.eyes === 'smile' ? `<path d="M46 ${y + 8}q4 3.2 8 0" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" opacity=".75"/>` : '';
  const crumb = (cls: string, pts: readonly (readonly [number, number])[]) => `<g class="${cls}" fill="${base}">${pts.map(([x, py], i) => `<circle class="crumb crumb-${i}" cx="${x}" cy="${py}" r="2.4"/>`).join('')}</g>`;
  return {
    body,
    face: `${blush}<g class="character-gaze"><g class="character-eyes" fill="currentColor">${eyes(a.eyes, y, b.spread)}</g></g>${mouth}`,
    accessory: accessory(a.accessory, dark),
    extras: `${crumb('character-crumbs-up', [[38, 4], [52, -1], [64, 5]])}${crumb('character-crumbs-down', [[38, 95], [52, 99], [64, 94]])}<rect class="character-caret" x="90" y="64" width="3.4" height="10" rx="1.2" fill="currentColor"/>`,
  };
}

export function characterSvg(a: AssistantAppearance, size = 96): string {
  const p = characterParts(a);
  return `<svg xmlns="http://www.w3.org/2000/svg" viewBox="-8 -8 116 116" width="${size}" height="${size}" color="${inkFor(a.color)}">${p.body}<g>${p.face}</g>${p.accessory}</svg>`;
}

export function characterIconSvg(a: AssistantAppearance, background: string, size = 1024): string {
  const p = characterParts(a);
  return `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 100 100" width="${size}" height="${size}"><rect width="100" height="100" fill="${background}"/>` +
    `<g transform="translate(2 6) scale(1.28)" color="${inkFor(a.color)}">${p.body}<g>${p.face}</g>${p.accessory}</g></svg>`;
}
