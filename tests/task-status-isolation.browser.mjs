import { accessSync, constants, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { spawn, spawnSync } from 'node:child_process';
import { homedir, tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import assert from 'node:assert/strict';

const repo = fileURLToPath(new URL('../', import.meta.url));
const fixtures = join(repo, 'tests/fixtures/task-status');
const reasonQa = process.env.TASK_REASON_QA === '1';
if (reasonQa) {
  await import('./task-error-card.browser.mjs');
}
const evidence = join(repo, '.omo/evidence/task-status-isolation', `run-${Date.now()}`);
const skill = process.env.OMO_BROWSER_SKILL_ROOT || join(homedir(), '.codex/plugins/cache/sisyphuslabs/omo/5.1.7/skills/browser');
const chrome = process.env.CHROME_PATH || '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome';
let build, profile, server, browser, page, origin, omowright;
const results = [];
const browserErrors = [];
async function until(predicate) {
  const deadline = performance.now() + 6000;
  while (!await page.evaluate(source => eval(`(${source})`)(), predicate.toString())) {
    assert.ok(performance.now() < deadline, `Timed out: ${predicate}`);
    await new Promise(resolve => setTimeout(resolve, 30));
  }
}
const click = id => page.locator(`#${id}`).click();
const state = () => page.evaluate(() => ({ selected: document.querySelector('#selected').textContent, text: document.querySelector('#status').textContent.trim(), disabled: document.querySelector('#status button')?.disabled ?? null, workStops: [...document.querySelectorAll('#work button')].filter(button=>/중지|취소|stop/i.test((button.getAttribute('aria-label')??'')+button.textContent)).length }));
async function scenario(name, run) {
  await fetch(origin + '/fixture/reset', { method: 'POST' });
  await page.goto(origin, { waitUntil: 'load' });
  await until(() => Boolean(document.querySelector('#task-a')));
  await omowright.repinViewport(page, { width:900,height:600 });
  console.log(omowright.compactSnapshot(await page.snapshot()));
  try { await run(); results.push({ name, pass: true }); }
  catch (error) { results.push({ name, pass: false, error: String(error) }); }
  writeFileSync(join(evidence, `${name}.json`), JSON.stringify(await state(), null, 2));
  writeFileSync(join(evidence, `${name}.png`), await page.screenshot());
}
try {
  mkdirSync(evidence, { recursive: true });
  accessSync(chrome, constants.X_OK);
  const { loadOmowright } = await import(join(skill, 'scripts/omowright.mjs'));
  ({ omowright } = await loadOmowright());
  build = mkdtempSync(join(tmpdir(), 'task-status-build-'));
  const sourceFiles = ['apps/web/src/TaskStatus.tsx','apps/web/src/TaskStatus.css','apps/web/src/WorkPanel.tsx','apps/web/src/styles.css','tests/task-status-isolation.browser.mjs','tests/fixtures/task-status/harness.tsx','tests/fixtures/task-status/server.ts'];
  writeFileSync(join(evidence, 'source-hashes.json'), JSON.stringify(Object.fromEntries(sourceFiles.map(path => [path,createHash('sha256').update(readFileSync(join(repo,path))).digest('hex')])),null,2));
  const compiled = spawnSync('bun', ['build', join(fixtures, 'harness.tsx'), '--target', 'browser', '--outdir', build], { cwd: repo, encoding: 'utf8' });
  writeFileSync(join(evidence, 'build.log'), `${compiled.stdout}${compiled.stderr}`);
  assert.equal(compiled.status, 0);
  server = spawn('bun', [join(fixtures, 'server.ts')], { cwd: repo, env: { ...process.env, TASK_STATUS_BUILD: build, TASK_STATUS_PORT: '0' }, stdio: ['ignore', 'pipe', 'pipe'] });
  origin = await new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error('Server startup timed out')), 10000);
    server.once('error', error => { clearTimeout(timer); reject(error); });
    server.once('exit', code => { clearTimeout(timer); reject(new Error(`Server exited ${code}`)); });
    server.stdout.on('data', data => {
      const match = String(data).match(/http:\/\/127\.0\.0\.1:\d+/);
      if (match) { clearTimeout(timer); resolve(match[0]); }
    });
  });
  profile = mkdtempSync(join(tmpdir(), 'task-status-browser-'));
  browser = await omowright.connectPipe({ browserPath: chrome, browserArgs: ['--headless', '--no-first-run', `--user-data-dir=${profile}`], storageRoot: profile, readinessTimeoutMs: 30000 });
  page = await browser.newTab('about:blank');
  page.on('pageerror', error => browserErrors.push(String(error)));
  await omowright.repinViewport(page, { width: 900, height: 600 });
  await scenario('quiet-status-for-nonfailure-states', async () => {
    for(const id of ['task-a','queued-task','waiting-task','done-task','task-b','no-task']) {
      await click(id);assert.equal((await state()).text,'','No stop, queue, or waiting row above composer');
      assert.equal(await page.locator('#status button').count(),0);
    }
    assert.equal((await(await fetch(origin+'/fixture/state')).json()).actionRequests,0);
  });
  await scenario('work-panel-has-no-stop-controls', async () => {
    assert.equal(await page.locator('#work article').count(),6);
    assert.equal((await state()).workStops,0);
    assert.equal(await page.locator('#work .work-actions button').count(),7,'Request navigation remains; succeeded also has reply navigation');
    assert.equal((await(await fetch(origin+'/fixture/state')).json()).actionRequests,0);
  });
} finally {
  writeFileSync(join(evidence, 'results.json'), JSON.stringify(results, null, 2));
  console.log(JSON.stringify({ evidence, results }, null, 2));
  writeFileSync(join(evidence, 'browser-errors.json'), JSON.stringify(browserErrors,null,2));
  try { await browser?.close(); }
  finally {
    if (server?.pid && server.exitCode === null) {
      const closed = new Promise(resolve => server.once('exit', resolve));
      server.kill(); await closed;
    }
    if (profile) rmSync(profile, { recursive: true, force: true });
    if (build) rmSync(build, { recursive: true, force: true });
  }
  writeFileSync(join(evidence, 'cleanup.json'), JSON.stringify({browserClosed:true,serverExited:true,profileRemoved:true,buildRemoved:true},null,2));
}
assert.equal(results.length, 2);
assert.ok(results.every(result => result.pass));
assert.deepEqual(browserErrors, []);
