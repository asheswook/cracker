import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { homedir, tmpdir } from 'node:os';
import { join } from 'node:path';
const evidence = new URL('../.omo/evidence/message-notifications/', import.meta.url).pathname;
const origin = process.env.NOTIFICATION_FIXTURE_URL ?? 'http://127.0.0.1:43128';
const skill = join(homedir(), '.codex/plugins/cache/sisyphuslabs/omo/5.1.7/skills/browser');
const { loadOmowright } = await import(join(skill, 'scripts/omowright.mjs'));
const { omowright } = await loadOmowright();
const profile = mkdtempSync(join(tmpdir(), 'notification-qa-'));
const browser = await omowright.connectPipe({ browserPath: '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome', browserArgs: ['--headless', '--no-first-run', `--user-data-dir=${profile}`], storageRoot: profile });
const page = await browser.newTab('about:blank');
const results = [], snapshots = [];
mkdirSync(evidence, { recursive: true });
const state = async () => (await fetch(`${origin}/fixture/state`)).json();
const control = async action => fetch(`${origin}/fixture/control`, { method: 'POST', body: JSON.stringify({ action }) });
async function waitFor(predicate) {
  const deadline = Date.now() + 8000;
  while (!await predicate()) { assert.ok(Date.now() < deadline, 'Timed out'); await new Promise(resolve => setTimeout(resolve, 30)); }
}
async function ui() { return page.evaluate(() => ({ checked: document.querySelector('.notification-preference input')?.checked, disabled: document.querySelector('.notification-preference input')?.disabled, error: document.querySelector('[role="alert"]')?.textContent ?? '', bridgeCalls: window.fixtureBridgeCalls ?? [], overflow: document.documentElement.scrollWidth > innerWidth })); }
async function click(selector) { snapshots.push(omowright.compactSnapshot(await page.snapshot())); if (selector === '.notification-preference input') await page.evaluate(() => document.querySelector('.notification-preference input').click()); else await page.locator(selector).click(); }
async function capture(name) { const data = { origin, ui: await ui(), server: await state() }; writeFileSync(join(evidence, `${name}.json`), JSON.stringify(data, null, 2)); writeFileSync(join(evidence, `${name}.png`), await page.screenshot()); }
try {
  for (const lane of ['web', 'native']) {
    await control('reset');
    await omowright.repinViewport(page, { width: 900, height: 850 });
    await page.goto(`${origin}/${lane === 'native' ? '?native=1' : ''}`, { waitUntil: 'load' });
    await waitFor(async () => (await ui()).checked === true);
    assert.equal((await ui()).bridgeCalls.length > 0, lane === 'native');
    await capture(`${lane}-default-on`);
    await click('summary');
    await click('#hold-get');
    await waitFor(async () => (await state()).pendingGet);
    await click('.notification-preference input');
    await waitFor(async () => (await ui()).checked === false && !(await ui()).disabled);
    await click('#release-get');
    await waitFor(async () => !(await state()).pendingGet);
    await new Promise(resolve => setTimeout(resolve, 100));
    assert.equal((await ui()).checked, false);
    await capture(`${lane}-stale-get-ignored`);
    results.push({ lane, scenario: 'late GET cannot overwrite saved OFF', pass: true });
    await click('#fail-put');
    await click('.notification-preference input');
    await waitFor(async () => !!(await ui()).error);
    assert.equal((await ui()).checked, false);
    assert.equal((await state()).content, false);
    await capture(`${lane}-save-failure`);
    results.push({ lane, scenario: 'failed PUT retains server value with visible error', pass: true });
    await click('#hold-put');
    const before = (await state()).puts;
    snapshots.push(omowright.compactSnapshot(await page.snapshot()));
    await page.evaluate(() => { const box = document.querySelector('.notification-preference input'); box.click(); box.click(); });
    await waitFor(async () => (await state()).pendingPut);
    assert.equal((await state()).puts, before + 1);
    assert.equal((await ui()).disabled, true);
    const gets = (await state()).gets;
    await click('#refresh');
    assert.equal((await state()).gets, gets);
    await click('#release-put');
    await waitFor(async () => (await ui()).checked === true && !(await ui()).disabled);
    assert.equal((await ui()).error, '');
    results.push({ lane, scenario: 'duplicate clicks issue one PUT; focus does not race pending save', pass: true });
    await click('#mount'); await click('#mount');
    await waitFor(async () => (await ui()).checked === true);
    await click('.notification-preference input');
    await waitFor(async () => (await ui()).checked === false && !(await ui()).disabled);
    await click('#mount'); await click('#mount');
    await waitFor(async () => (await ui()).checked === false);
    results.push({ lane, scenario: 'ON and OFF persist across panel reopen', pass: true });
    await click('summary');
    await omowright.repinViewport(page, { width: 390, height: 844 });
    assert.equal((await ui()).overflow, false);
    await capture(`${lane}-mobile-off`);
  }
} finally {
  writeFileSync(join(evidence, 'browser-results.json'), JSON.stringify({ origin, results }, null, 2));
  writeFileSync(join(evidence, 'browser-snapshots.json'), JSON.stringify(snapshots, null, 2));
  await browser.close();
  rmSync(profile, { recursive: true, force: true });
}
console.log(JSON.stringify(results, null, 2));
assert.equal(results.length, 8);
