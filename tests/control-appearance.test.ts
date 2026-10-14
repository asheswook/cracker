import { expect, test } from 'bun:test';
import { z } from 'zod';
import { AppearanceConflict, AppearanceSettings, defaultAppearance } from '../packages/appearance/schema';
import { DaemonPoll, Persona } from '../packages/protocol';
import { controlFixture } from './control-fixture';

const f = controlFixture();
const current = async (token = f.client) => AppearanceSettings.parse(await (await f.request('/v1/appearance', token)).json());
const put = (body: unknown, token = f.client) => f.request('/v1/appearance', token, body, 'PUT');

test('appearance starts with the specified default and an independent workspace revision', async () => {
  // Given / When
  const response = await f.request('/v1/appearance');
  const saved = AppearanceSettings.parse(await response.json());
  const alien = await current(f.alienToken);
  // Then
  expect(response.status).toBe(200);
  expect(response.headers.get('Cache-Control')).toBe('no-store');
  expect(saved.appearance).toEqual(defaultAppearance);
  expect(alien.appearance).toEqual(defaultAppearance);
  expect(saved.revision).not.toBe(alien.revision);
});

test('appearance persists all supported fields and survives a fresh GET', async () => {
  // Given
  const base = await current();
  const appearance = { version: 2, biscuit: 'ring', color: 'cocoa', eyes: 'smile', blush: true, accessory: 'beret' } as const;
  // When
  const response = await put({ appearance, expected_revision: base.revision });
  const saved = AppearanceSettings.parse(await response.json());
  // Then
  expect(response.status).toBe(200);
  expect(response.headers.get('Cache-Control')).toBe('no-store');
  expect(saved.appearance).toEqual(appearance);
  expect(saved.revision).not.toBe(base.revision);
  expect(await current()).toEqual(saved);
});

const choices = {
  biscuit: ['saltine', 'butter', 'graham', 'sandwich', 'wafer', 'ring'],
  color: ['wheat', 'butter', 'honey', 'cinnamon', 'cocoa', 'matcha', 'berry', 'charcoal'],
  eyes: ['dots', 'ovals', 'sleepy', 'smile'],
  blush: [true, false],
  accessory: ['none', 'headphones', 'beret', 'bow'],
} as const;
for (const [field, options] of Object.entries(choices)) for (const option of options) {
  test(`appearance persists the supported ${field} option ${option}`, async () => {
    // Given
    const base = await current(), appearance = { ...defaultAppearance, [field]: option };
    // When
    const response = await put({ appearance, expected_revision: base.revision });
    // Then
    expect(response.status).toBe(200);
    expect(AppearanceSettings.parse(await response.json()).appearance).toEqual(appearance);
  });
}

test('competing appearance writes have one winner and a conflict containing the exact current value', async () => {
  // Given
  const base = await current();
  // When
  const responses = await Promise.all(['wafer', 'ring'].map(biscuit => put({ appearance: { ...base.appearance, biscuit }, expected_revision: base.revision })));
  // Then
  expect(responses.map(response => response.status).sort()).toEqual([200, 409]);
  const winner = responses.find(response => response.status === 200);
  const conflict = responses.find(response => response.status === 409);
  if (!winner || !conflict) throw new TypeError('Missing expected concurrent results');
  const saved = AppearanceSettings.parse(await winner.json());
  expect(AppearanceConflict.parse(await conflict.json()).current).toEqual(saved);
  expect(await current()).toEqual(saved);
});

test('an exact appearance retry does not change the revision', async () => {
  // Given
  const base = await current();
  const body = { appearance: { ...base.appearance, color: 'matcha' }, expected_revision: base.revision };
  const saved = AppearanceSettings.parse(await (await put(body)).json());
  // When
  const response = await put(body);
  // Then
  expect(response.status).toBe(200);
  expect(AppearanceSettings.parse(await response.json())).toEqual(saved);
});

test('a stale appearance retry cannot undo an intervening change', async () => {
  // Given
  const base = await current();
  const firstBody = { appearance: { ...base.appearance, eyes: 'dots' }, expected_revision: base.revision };
  const first = AppearanceSettings.parse(await (await put(firstBody)).json());
  const second = AppearanceSettings.parse(await (await put({ appearance: { ...first.appearance, eyes: 'sleepy' }, expected_revision: first.revision })).json());
  // When
  const stale = await put(firstBody);
  // Then
  expect(stale.status).toBe(409);
  expect(AppearanceConflict.parse(await stale.json()).current).toEqual(second);
  expect(await current()).toEqual(second);
});

test('appearance writes stay isolated from another workspace', async () => {
  // Given
  const base = await current(), alien = await current(f.alienToken);
  // When
  const response = await put({ appearance: { ...base.appearance, color: 'butter' }, expected_revision: alien.revision });
  // Then
  expect(response.status).toBe(409);
  expect(await current()).toEqual(base);
  expect(await current(f.alienToken)).toEqual(alien);
});

const invalid = [
  ['unknown version', { ...defaultAppearance, version: 3 }], ['unknown biscuit', { ...defaultAppearance, biscuit: 'square' }],
  ['unknown color', { ...defaultAppearance, color: '#ff0000' }], ['unknown eyes', { ...defaultAppearance, eyes: 'custom' }],
  ['non-boolean blush', { ...defaultAppearance, blush: 'yes' }], ['unknown accessory', { ...defaultAppearance, accessory: 'cape' }],
  ['null option', { ...defaultAppearance, eyes: null }], ['extra asset', { ...defaultAppearance, image_url: 'https://example.com/image.png' }],
  ['missing fields', { version: 2, biscuit: 'ring' }], ['mixed legacy keys', { ...defaultAppearance, shape: 'flower' }],
] as const;
for (const [label, appearance] of invalid) test(`appearance rejects ${label} without changing saved values`, async () => {
  // Given
  const base = await current();
  // When
  const response = await put({ appearance, expected_revision: base.revision });
  // Then
  expect(response.status).toBe(400);
  expect(await current()).toEqual(base);
});

for (const extra of [{}, { expected_revision: 'invalid' }, { expected_revision: crypto.randomUUID(), workspace_id: crypto.randomUUID() }]) {
  test(`appearance requires a valid revision and rejects unknown request fields: ${Object.keys(extra).join(',')}`, async () => {
    // Given / When
    const response = await put({ appearance: defaultAppearance, ...extra });
    // Then
    expect(response.status).toBe(400);
  });
}

test('appearance bounds the request body', async () => {
  // Given
  const base = await current();
  // When
  const response = await put({ appearance: { ...defaultAppearance, color: 'x'.repeat(5000) }, expected_revision: base.revision });
  // Then
  expect(response.status).toBe(413);
});

test('the database rejects null or extra appearance fields even outside HTTP validation', async () => {
  // Given / When / Then
  for (const appearance of [{ ...defaultAppearance, eyes: null }, { ...defaultAppearance, blush: 'false' }, { ...defaultAppearance, unexpected: true }]) {
    await expect(Promise.resolve(f.sql`UPDATE assistant.workspaces SET appearance=${JSON.stringify(appearance)}::text::jsonb WHERE id=${f.workspace}`))
      .rejects.toMatchObject({ code: '23514' });
  }
});

test('appearance edits neither change persona settings nor enter daemon assignment data', async () => {
  // Given
  await f.finishActive();
  const Settings = z.object({ persona: Persona, instructions: z.string(), revision: z.uuid() });
  const settings = Settings.parse(await (await f.request('/v1/settings')).json());
  const base = await current();
  // When
  expect((await put({ appearance: { ...base.appearance, accessory: 'beret' }, expected_revision: base.revision })).status).toBe(200);
  await f.newTask();
  const raw: unknown = await (await f.request('/v1/daemon/poll', f.machine)).json();
  const assignment = DaemonPoll.parse(raw).assignment;
  // Then
  expect(Settings.parse(await (await f.request('/v1/settings')).json())).toEqual(settings);
  expect(assignment?.persona).toEqual(settings.persona);
  expect(assignment?.instructions).toBe(settings.instructions);
  const rawAssignment = z.object({ assignment: z.object({ persona: z.record(z.string(), z.unknown()) }).passthrough() }).parse(raw).assignment;
  expect(Object.keys(rawAssignment)).not.toContain('appearance');
  expect(Object.keys(rawAssignment.persona)).not.toContain('appearance');
});

test('persona saves do not invalidate an open appearance editor revision', async () => {
  // Given
  const base = await current();
  const settings = z.object({ persona: Persona, revision: z.uuid() }).parse(await (await f.request('/v1/settings')).json());
  expect((await f.request('/v1/settings', f.client, { persona: { ...settings.persona, name: 'Independent name' }, expected_revision: settings.revision }, 'PUT')).status).toBe(200);
  // When
  const response = await put({ appearance: { ...base.appearance, color: 'matcha' }, expected_revision: base.revision });
  // Then
  expect(response.status).toBe(200);
  expect(AppearanceSettings.parse(await response.json()).appearance.color).toBe('matcha');
});

test('appearance routes reject VM credentials', async () => {
  // Given / When
  const get = await f.request('/v1/appearance', f.machine);
  const update = await put({ appearance: defaultAppearance, expected_revision: crypto.randomUUID() }, f.machine);
  // Then
  expect(get.status).toBe(403);
  expect(update.status).toBe(403);
});

test('legacy v1 input is stored as the parsed v2 object, never raw', async () => {
  // Given
  const base = await current();
  const legacy = { version: 1, shape: 'heart', color: 'blue', eyes: 'sparkle', eyewear: 'monocle', accessory: 'crown' };
  // When
  const response = await put({ appearance: legacy, expected_revision: base.revision });
  // Then
  expect(response.status).toBe(200);
  const expected = { version: 2, biscuit: 'ring', color: 'charcoal', eyes: 'smile', blush: false, accessory: 'none' } as const;
  expect(AppearanceSettings.parse(await response.json()).appearance).toEqual(expected);
  expect((await current()).appearance).toEqual(expected);
  expect(JSON.stringify(await f.sql`SELECT appearance FROM assistant.workspaces WHERE id=${f.workspace}`)).not.toContain('eyewear');
});
