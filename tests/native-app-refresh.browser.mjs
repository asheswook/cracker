import { accessSync, constants, existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { spawn, spawnSync } from 'node:child_process';
import { homedir, tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import assert from 'node:assert/strict';

const phase = process.env.PHASE || 'green';
const repo = fileURLToPath(new URL('../', import.meta.url));
const evidence = join(repo, '.omo/evidence/native-resume-recovery');
const fixtures = join(repo, 'tests/fixtures/native-app-refresh');
const skillRoot = process.env.OMO_BROWSER_SKILL_ROOT || join(homedir(), '.codex/plugins/cache/sisyphuslabs/omo/5.1.7/skills/browser');
const browserPath = process.env.CHROME_PATH || '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome';
let origin;
let omowright;
let browser;
let server;
let profile;
let build;
const results = [];
let page;
async function waitFor(predicate, timeout = 8000) {
  const deadline = performance.now() + timeout;
  while (!await page.evaluate(source => eval(`(${source})`)(), predicate.toString())) {
    assert.ok(performance.now() < deadline, `Timed out: ${predicate}`);
    await new Promise(resolve => setTimeout(resolve, 50));
  }
}
async function settle() { await page.evaluate(() => new Promise(resolve => setTimeout(resolve, 150))); }
async function capture(name) {
  await settle();
  const state = await page.evaluate(() => ({ error: document.querySelector('.header-error')?.textContent || document.querySelector('#hook-error')?.textContent || '', calls: fixture.calls, events: fixture.events, body: document.body.innerText.slice(0, 2500) }));
  writeFileSync(`${evidence}/${phase}-${name}.json`, JSON.stringify(state, null, 2));
  writeFileSync(`${evidence}/${phase}-${name}.png`, await page.screenshot());
  return state;
}
async function open(query = '?mode=hold') {
  await page.goto(origin + '/' + query, { waitUntil: 'load' });
  await waitFor(() => fixture.calls.some(call => call.method === 'getNotificationState'));
  console.log(JSON.stringify(omowright.compactSnapshot(await page.snapshot())));
}
async function scenario(name, run) {
  try { await run(); results.push({ name, pass: true }); }
  catch (error) { results.push({ name, pass: false, error: String(error) }); }
}
try {
  mkdirSync(evidence, { recursive: true });
  const { loadOmowright } = await import(join(skillRoot, 'scripts/omowright.mjs'));
  ({ omowright } = await loadOmowright());
  build = mkdtempSync(join(tmpdir(), 'native-refresh-build-'));
  for (const [command, args, cwd, log] of [
    ['pnpm', ['exec', 'vite', 'build', '--outDir', join(build, 'dist')], join(repo, 'apps/web'), 'build'],
    ['bun', ['build', join(fixtures, 'hook.tsx'), '--target', 'browser', '--outfile', join(build, 'hook.js')], repo, 'hook-build'],
  ]) {
    const result = spawnSync(command, args, { cwd, encoding: 'utf8' });
    writeFileSync(join(evidence, `${phase}-${log}.txt`), `${result.stdout || ''}${result.stderr || ''}\nExit code: ${result.status}\n`);
    assert.equal(result.status, 0, `${command} failed: ${result.error || result.stderr}`);
  }
  server = spawn('bun', [join(fixtures, 'server.ts')], { cwd: repo, env: { ...process.env, NATIVE_FIXTURE_BUILD_DIR: build, NATIVE_FIXTURE_PORT: '0' }, stdio: ['ignore', 'pipe', 'pipe'] });
  origin = await new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error('Fixture server startup timed out')), 10000);
    server.once('error', error => { clearTimeout(timer); reject(error); });
    server.once('exit', code => { clearTimeout(timer); reject(new Error(`Fixture server exited: ${code}`)); });
    server.stdout.on('data', chunk => {
      const match = String(chunk).match(/http:\/\/127\.0\.0\.1:\d+/);
      if (match) { clearTimeout(timer); resolve(match[0]); }
    });
  });
  profile = mkdtempSync(join(tmpdir(), 'native-resume-'));
  accessSync(browserPath, constants.X_OK);
  browser = await omowright.connectPipe({ browserPath, browserArgs: ['--headless', '--no-first-run', `--user-data-dir=${profile}`], storageRoot: profile });
  page = await browser.newTab('about:blank');
  await omowright.repinViewport(page, { width: 1280, height: 900 });
  await scenario('real 30s timeout clears after successful passive refresh', async () => {
    await open();
    await waitFor(() => document.querySelector('.header-error')?.textContent.includes('기기 응답이 늦어지고'), 34000);
    const failure = await capture('real-timeout');
    assert.equal(failure.calls.filter(call => call.method === 'getNotificationState').length, 1, 'no retry spin after failure');
    await page.locator('#fixture-success').click();
    await waitFor(() => fixture.calls.filter(call => call.method === 'getNotificationState').length === 2);
    const recovered = await capture('real-timeout-recovered');
    assert.equal(recovered.error, '', 'successful passive refresh clears its own error');
  });
  await scenario('queued burst continues after rejected in-flight request and coalesces', async () => {
    await open();
    await page.evaluate(() => { fixture.mode = 'success'; fixture.event(20); });
    await page.locator('#fixture-fail').click();
    await settle();
    const state = await capture('queued-failure');
    assert.equal(state.calls.filter(call => call.method === 'getNotificationState').length, 2, 'pending burst must issue exactly one follow-up without third trigger');
    assert.equal(state.error, '');
  });
  await scenario('ready failure survives passive success', async () => {
    await open('?mode=success&readyError=1');
    const before = await capture('ready-error');
    assert.ok(before.error.includes('기기 알림 설정을 확인하지 못했어요'));
    await page.locator('#fixture-success').click();
    assert.equal((await capture('ready-error-preserved')).error, before.error);
  });
  await scenario('invalid result link survives passive success', async () => {
    await open('?mode=success&conversation=22222222-2222-4222-8222-222222222222');
    const before = await capture('result-error');
    assert.ok(before.error.includes('이 결과 링크를 열 수 없어요'));
    await page.locator('#fixture-success').click();
    assert.equal((await capture('result-error-preserved')).error, before.error);
  });
  await scenario('user logout failure has priority and survives passive recovery', async () => {
    await open('?mode=success');
    console.log(JSON.stringify(omowright.compactSnapshot(await page.snapshot())));
    await page.locator('.desktop-sidebar button').last().click();
    await waitFor(() => document.querySelector('.header-error')?.textContent.includes('권한'));
    const before = await capture('action-error');
    await page.evaluate(() => { fixture.mode = 'fail'; fixture.event(); });
    assert.equal((await capture('action-during-passive-error')).error, before.error);
    await page.locator('#fixture-success').click();
    assert.equal((await capture('action-error-preserved')).error, before.error);
  });
  await scenario('persistent failure performs no unprompted retries', async () => {
    await open('?mode=fail');
    await waitFor(() => !!document.querySelector('.header-error'));
    await page.evaluate(() => new Promise(resolve => setTimeout(resolve, 1000)));
    const state = await capture('no-spin');
    assert.equal(state.calls.filter(call => call.method === 'getNotificationState').length, 1);
  });
  await scenario('visibility recovery without focus; hidden transition does not refresh', async () => {
    await open('?mode=fail');
    await waitFor(() => !!document.querySelector('.header-error'));
    await page.evaluate(() => {
      fixture.mode = 'success';
      Object.defineProperty(document, 'visibilityState', { configurable: true, get: () => 'hidden' });
      document.dispatchEvent(new Event('visibilitychange'));
    });
    const hidden = await capture('visibility-hidden');
    assert.equal(hidden.calls.filter(call => call.method === 'getNotificationState').length, 1);
    assert.notEqual(hidden.error, '');
    await page.evaluate(() => {
      Object.defineProperty(document, 'visibilityState', { configurable: true, get: () => 'visible' });
      document.dispatchEvent(new Event('visibilitychange'));
    });
    await settle();
    const visible = await capture('visibility-visible-recovered');
    assert.equal(visible.calls.filter(call => call.method === 'getNotificationState').length, 2);
    assert.equal(visible.error, '', 'visible transition alone must recover passive refresh');
  });
  await scenario('disconnect cancels pending work and late failure; reconnect refreshes', async () => {
    await page.goto(origin + '/hook?mode=hold', { waitUntil: 'load' });
    await waitFor(() => fixture.pending.length === 1);
    await page.evaluate(() => fixture.event(5));
    console.log(JSON.stringify(omowright.compactSnapshot(await page.snapshot())));
    await page.locator('#connection').click();
    await waitFor(() => document.querySelector('#connection').textContent.includes('false'));
    await page.evaluate(() => { fixture.fail(); fixture.event(); dispatchEvent(new Event('focus')); document.dispatchEvent(new Event('visibilitychange')); });
    const disconnected = await capture('disconnected-late-failure');
    assert.equal(disconnected.calls.filter(call => call.method === 'getNotificationState').length, 1);
    assert.equal(disconnected.error, '');
    await page.evaluate(() => { fixture.mode = 'success'; });
    await page.locator('#connection').click();
    await waitFor(() => fixture.calls.filter(call => call.method === 'getNotificationState').length === 2);
    assert.equal((await capture('reconnected')).error, '');
  });
  await scenario('unmount removes refresh listeners and discards queued work', async () => {
    await page.goto(origin + '/hook?mode=hold', { waitUntil: 'load' });
    await waitFor(() => fixture.pending.length === 1);
    await page.evaluate(() => fixture.event(5));
    console.log(JSON.stringify(omowright.compactSnapshot(await page.snapshot())));
    await page.locator('#mount').click();
    await waitFor(() => !document.querySelector('#hook-error'));
    await page.evaluate(() => { fixture.release(); fixture.event(); dispatchEvent(new Event('focus')); document.dispatchEvent(new Event('visibilitychange')); });
    const unmounted = await capture('unmounted');
    assert.equal(unmounted.calls.filter(call => call.method === 'getNotificationState').length, 1);
    await page.evaluate(() => { fixture.mode = 'success'; });
    await page.locator('#mount').click();
    await waitFor(() => fixture.calls.filter(call => call.method === 'getNotificationState').length === 2);
    assert.equal((await capture('remounted')).error, '');
  });
} finally {
  writeFileSync(`${evidence}/${phase}-results.json`, JSON.stringify(results, null, 2));
  console.log(JSON.stringify(results, null, 2));
  try {
    await browser?.close();
  } finally {
    if (server?.pid && server.exitCode === null) {
      const closed = new Promise(resolve => server.once('exit', resolve));
      server.kill();
      await closed;
    }
    if (profile) rmSync(profile, { recursive: true, force: true });
    if (build) rmSync(build, { recursive: true, force: true });
    writeFileSync(join(evidence, `${phase}-cleanup.json`), JSON.stringify({ serverPid: server?.pid, serverExitCode: server?.exitCode, serverSignal: server?.signalCode, profileRemoved: !profile || !existsSync(profile), buildRemoved: !build || !existsSync(build) }, null, 2));
  }
}
assert.ok(results.every(result => result.pass), 'All regression scenarios must pass');
