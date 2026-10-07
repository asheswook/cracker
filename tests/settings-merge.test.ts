import { expect, test } from 'bun:test';
import { Instructions } from '../apps/web/src/settings/types';
import { mergeSettings } from '../apps/web/src/settings/settingsMerge';
const base = Instructions.parse({ revision: '11111111-1111-4111-8111-111111111111', instructions: 'Original sources', persona: { name: 'Assistant', role: '', style: '' } });
test('disjoint edits preserve both devices and current revision', () => {
  const local = { ...base, persona: { ...base.persona, name: 'My colleague' } };
  const latest = Instructions.parse({ ...base, revision: '22222222-2222-4222-8222-222222222222', instructions: 'New sources', persona: { ...base.persona, role: 'Research' } });
  const result = mergeSettings({ base, local, latest });
  expect(result.conflicts).toEqual([]);
  expect(result.merged).toEqual({ ...latest, persona: { ...latest.persona, name: 'My colleague' } });
});
test('different changes to the same field require an explicit choice', () => {
  const local = { ...base, instructions: 'My sources' }, latest = { ...base, instructions: 'Their sources' };
  expect(mergeSettings({ base, local, latest }).conflicts).toEqual(['instructions']);
  expect(mergeSettings({ base, local, latest }, { instructions: 'latest' }).merged.instructions).toBe('Their sources');
  expect(mergeSettings({ base, local, latest }, { instructions: 'local' }).merged.instructions).toBe('My sources');
});
test('intentional clearing survives a disjoint edit', () => {
  const local = { ...base, instructions: '' }, latest = { ...base, persona: { ...base.persona, style: 'Concise' } };
  expect(mergeSettings({ base, local, latest }).merged).toEqual({ ...latest, instructions: '' });
});
test('equal targets converge without a conflict', () => {
  const local = { ...base, instructions: 'Same' }, latest = { ...base, instructions: 'Same' };
  expect(mergeSettings({ base, local, latest }).conflicts).toEqual([]);
});
