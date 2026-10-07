import type { AssistantAppearance } from './types';

export const appearanceChoices = {
  shape: [['circle', '동그라미'], ['capsule', '캡슐'], ['flower', '꽃'], ['heart', '하트'], ['diamond', '다이아몬드'], ['rounded-triangle', '둥근 삼각형']],
  color: [['coral', '코랄'], ['pink', '분홍'], ['orchid', '오키드'], ['violet', '보라'], ['blue', '파랑'], ['cyan', '하늘'], ['teal', '청록'], ['lime', '라임'], ['yellow', '노랑']],
  eyes: [['oval', '타원'], ['dots', '동그란 눈'], ['sleepy', '졸린 눈'], ['sparkle', '반짝이는 눈']],
  eyewear: [['none', '없음'], ['monocle', '외안경'], ['round', '둥근 안경'], ['sunglasses', '선글라스']],
  accessory: [['none', '없음'], ['headphones', '헤드폰'], ['bow', '나비넥타이'], ['beanie', '비니'], ['crown', '왕관']],
} as const;

export const characterColors = {
  coral: ['#ffbc91', '#f17e56', '#b94535'], pink: ['#ffc5da', '#ed8cb3', '#ad4777'],
  orchid: ['#efc4f2', '#c78cd0', '#865197'], violet: ['#cfc6ff', '#9a8add', '#6458a4'],
  blue: ['#b8d9ff', '#7ca9e2', '#4774b0'], cyan: ['#b6edf5', '#72c6d4', '#398b9d'],
  teal: ['#b8e7d5', '#70bca3', '#397e69'], lime: ['#e3efb1', '#b6cc6c', '#788d3f'],
  yellow: ['#fff0b3', '#ebc75f', '#aa8038'],
} as const satisfies Record<AssistantAppearance['color'], readonly [string, string, string]>;

export const bodyPaths = {
  circle: 'M84 50a34 34 0 1 1-68 0 34 34 0 0 1 68 0',
  capsule: 'M38 17h24c18 0 26 15 26 33S80 83 62 83H38c-18 0-26-15-26-33s8-33 26-33',
  flower: 'M50 14c9-10 21-3 22 7 13-3 23 8 18 20 11 7 10 22-3 27 1 14-13 22-24 16-8 11-22 9-27-3-13 4-25-5-23-18C1 56 4 41 16 36c-2-14 12-23 24-17 2-3 6-5 10-5',
  heart: 'M50 27C30-2 4 18 12 43c5 17 23 33 32 41 4 4 8 4 12 0 9-8 27-24 32-41C96 18 70-2 50 27',
  diamond: 'M42 15c5-6 11-6 16 0l28 28c5 5 5 11 0 16L58 87c-5 5-11 5-16 0L14 59c-5-5-5-11 0-16z',
  'rounded-triangle': 'M36 18c8-13 20-13 28 0l25 44c8 14 1 24-15 24H26C10 86 3 76 11 62z',
} as const satisfies Record<AssistantAppearance['shape'], string>;

export function sameAppearance(a: AssistantAppearance, b: AssistantAppearance): boolean {
  return a.shape === b.shape && a.color === b.color && a.eyes === b.eyes &&
    a.eyewear === b.eyewear && a.accessory === b.accessory;
}
