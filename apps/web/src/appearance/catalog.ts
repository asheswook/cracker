import type { AssistantAppearance } from './types';
export { characterPalette } from './character-svg';

export const appearanceChoices = {
  biscuit: [['saltine', '솔틴'], ['butter', '버터쿠키'], ['graham', '그레이엄'], ['sandwich', '샌드위치'], ['wafer', '웨이퍼'], ['ring', '링']],
  color: [['wheat', '밀'], ['butter', '버터'], ['honey', '꿀'], ['cinnamon', '시나몬'], ['cocoa', '코코아'], ['matcha', '말차'], ['berry', '베리'], ['charcoal', '차콜']],
  eyes: [['dots', '점'], ['ovals', '타원'], ['sleepy', '졸린 눈'], ['smile', '웃는 눈']],
  accessory: [['none', '없음'], ['headphones', '헤드폰'], ['beret', '베레모'], ['bow', '리본']],
} as const;

export const blushLabel = '볼터치';

export function sameAppearance(a: AssistantAppearance, b: AssistantAppearance): boolean {
  return a.biscuit === b.biscuit && a.color === b.color && a.eyes === b.eyes &&
    a.blush === b.blush && a.accessory === b.accessory;
}
