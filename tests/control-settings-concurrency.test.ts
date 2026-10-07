import { expect, test } from 'bun:test';
import { z } from 'zod';
import { Persona } from '../packages/protocol';
import { controlFixture } from './control-fixture';

const f = controlFixture();
const Settings = z.object({ instructions: z.string(), persona: Persona, revision: z.uuid(), onboarding: z.object({ status: z.enum(['pending','completed','skipped']), updated_at: z.string().nullable() }) });
const current = async () => Settings.parse(await (await f.request('/v1/settings')).json());
const put = (body: Record<string, unknown>) => f.request('/v1/settings', f.client, body, 'PUT');

test('a stale editor cannot overwrite instructions saved by another device', async () => {
  const base = Settings.parse(await (await f.request('/v1/settings')).json());
  const a = await f.request('/v1/settings', f.client, {
    instructions: 'Keep the newly reviewed research sources',
    expected_revision: base.revision,
  }, 'PUT');
  expect(a.status).toBe(200);

  const stale = await f.request('/v1/settings', f.client, {
    instructions: base.instructions,
    persona: { ...base.persona, name: 'Research partner' },
    expected_revision: base.revision,
  }, 'PUT');

  const actual = Settings.parse(await (await f.request('/v1/settings')).json());
  console.log(JSON.stringify({ scenario: 'stale-editor', status: stale.status, instructions: actual.instructions, name: actual.persona.name }));
  expect(stale.status).toBe(409);
  expect(actual.instructions).toBe('Keep the newly reviewed research sources');
  expect(actual.persona.name).toBe(base.persona.name);
});

test('competing writes have exactly one winner under the row lock', async () => {
  const base = await current();
  const changes = [{ persona: { ...base.persona, name: 'Parallel A' } }, { persona: { ...base.persona, role: 'Parallel B' } }];
  const replies = await Promise.all(changes.map(change => put({ ...change, expected_revision: base.revision })));
  expect(replies.map(r => r.status).sort()).toEqual([200, 409]);
  const winner = replies.find(r => r.status === 200);
  if (!winner) throw new TypeError('Expected one winner');
  expect(await current()).toEqual(Settings.parse(await winner.json()));
});

test('retrying an applied change does not revise settings or its onboarding timestamp', async () => {
  const base = await current();
  const body = { persona: { ...base.persona, style: 'Retry exact target' }, onboarding: { status: 'completed' }, expected_revision: base.revision };
  const applied = Settings.parse(await (await put(body)).json());
  const retry = await put(body);
  expect(retry.status).toBe(200);
  expect(Settings.parse(await retry.json())).toEqual(applied);
});

test('a retry cannot undo an intervening edit', async () => {
  const base = await current();
  const body = { persona: { ...base.persona, style: 'First target' }, expected_revision: base.revision };
  const first = Settings.parse(await (await put(body)).json());
  const latest = Settings.parse(await (await put({ persona: { ...first.persona, style: 'Intervening target' }, expected_revision: first.revision })).json());
  expect((await put(body)).status).toBe(409);
  expect(await current()).toEqual(latest);
});

test('stale onboarding skip cannot downgrade completed introduction', async () => {
  const base = await current();
  const pending = Settings.parse(await (await put({ onboarding: { status: 'skipped' }, expected_revision: base.revision })).json());
  const completed = Settings.parse(await (await put({ onboarding: { status: 'completed' }, expected_revision: pending.revision })).json());
  expect((await put({ onboarding: { status: 'skipped' }, expected_revision: pending.revision })).status).toBe(409);
  expect(await current()).toEqual(completed);
});

test('legacy writes without a version cannot silently overwrite current settings', async () => {
  const base = await current();
  const reply = await put({ persona: { ...base.persona, name: 'Old client' } });
  expect(reply.status).toBe(409);
  expect(await current()).toEqual(base);
});

test('versions from another workspace cannot update these settings', async () => {
  const base = await current();
  const alien = Settings.parse(await (await f.request('/v1/settings', f.alienToken)).json());
  expect((await put({ instructions: 'Alien version', expected_revision: alien.revision })).status).toBe(409);
  expect(await current()).toEqual(base);
});

test('changing instructions leaves onboarding timestamp unchanged', async () => {
  const base = await current();
  const updated = Settings.parse(await (await put({ instructions: 'Only instructions', onboarding: { status: base.onboarding.status }, expected_revision: base.revision })).json());
  expect(updated.instructions).toBe('Only instructions');
  expect(updated.revision).not.toBe(base.revision);
  expect(updated.onboarding).toEqual(base.onboarding);
});
