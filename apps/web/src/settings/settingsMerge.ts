import type { Instructions } from './types';

export const settingsFields = ['name', 'role', 'style', 'instructions'] as const;
export type SettingsField = (typeof settingsFields)[number];
export type SettingsChoice = 'local' | 'latest';
export type SettingsChoices = Partial<Record<SettingsField, SettingsChoice>>;
export const settingsLabels: Readonly<Record<SettingsField, string>> = {
  name: '이름', role: '역할', style: '말투와 답변 방식', instructions: '기본 지침',
};
export function settingsField(value: Instructions, field: SettingsField): string {
  return field === 'instructions' ? value.instructions : value.persona[field];
}
export function mergeSettings(edit: { readonly base: Instructions; readonly local: Instructions; readonly latest: Instructions }, choices: SettingsChoices = {}) {
  const merged = { ...edit.latest, persona: { ...edit.latest.persona } };
  const conflicts: SettingsField[] = [];
  for (const field of settingsFields) {
    const base = settingsField(edit.base, field), local = settingsField(edit.local, field), latest = settingsField(edit.latest, field);
    const conflict = local !== base && latest !== base && local !== latest;
    if (conflict && choices[field] === undefined) conflicts.push(field);
    const value = choices[field] === 'latest' || local === base ? latest : local;
    if (field === 'instructions') merged.instructions = value;
    else merged.persona[field] = value;
  }
  return { merged, conflicts };
}
