import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { createServer } from 'node:http';
import { once } from 'node:events';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';

const evidence = resolve('.omo/evidence/schedule-run-history');
mkdirSync(evidence, { recursive: true });
const require = createRequire(import.meta.url);
const { build } = createRequire(require.resolve('wrangler/package.json'))('esbuild');
const ids = Array.from({ length: 10 }, (_, index) => `00000000-0000-4000-8000-${String(index + 1).padStart(12, '0')}`);
const task = (id, date) => ({ id, conversation_id: ids[1], objective: '실행 결과', state: 'succeeded', reason: null, created_at: date, updated_at: date });
const runs = [
  { id: ids[2], state: 'pending', created_at: '2026-10-05T03:00:00Z', scheduled_for: '2026-10-05T02:00:00Z', task: null },
  { id: ids[3], state: 'dispatched', created_at: '2026-10-04T03:00:00Z', scheduled_for: '2026-10-04T02:00:00Z', task: task(ids[6], '2026-10-04T03:00:00Z') },
  { id: ids[4], state: 'dispatched', created_at: '2026-10-03T03:00:00Z', scheduled_for: '2026-10-03T02:00:00Z', task: task(ids[7], '2026-10-03T03:00:00Z') },
];
const older = { id: ids[5], state: 'dispatched', created_at: '2026-10-02T03:00:00Z', scheduled_for: null, task: task(ids[8], '2026-10-02T03:00:00Z') };
const bundle = await build({
  stdin: { contents: `
    import {createRoot} from 'react-dom/client';
    import {SchedulesPanel} from './apps/web/src/SchedulesPanel';
    import {useClient} from './apps/web/src/store';
    import './apps/web/src/styles.css';
    import './apps/web/src/assistant.css';
    function Fixture() { const state = useClient(); return <SchedulesPanel state={state} onTask={task=>{window.openedTask=task;}}/>; }
    createRoot(document.getElementById('root')).render(<Fixture/>);
  `, resolveDir: process.cwd(), loader: 'tsx' },
  bundle: true, write: false, format: 'esm', platform: 'browser', jsx: 'automatic',
  nodePaths: [resolve('apps/web/node_modules')], outdir: 'out', loader: { '.woff2': 'dataurl', '.woff': 'dataurl' },
});
const javascript = bundle.outputFiles.find(file => file.path.endsWith('.js'))?.text;
assert.ok(javascript);
const css = bundle.outputFiles.find(file => file.path.endsWith('.css'))?.text ?? '';
if (process.argv.includes('--build-only')) {
  console.log(JSON.stringify({ bundled: true, javascriptBytes: javascript.length, cssBytes: css.length }));
  process.exit(0);
}
const requests = [];
const errorScenarios = {
  unauthorized: { status: 401, message: '연결이 만료됐어요. 다시 연결해 주세요.' },
  forbidden: { status: 403, message: '이 작업에 대한 권한이 없어요.' },
  unavailable: { status: 500, message: '요청을 완료하지 못했어요. (500)' },
};
const historyError = '실행 기록을 새로고침한 뒤 다시 시도해 주세요.';
let release;
const server = createServer((request, response) => {
  const url = new URL(request.url, 'http://localhost');
  if (url.pathname === '/bundle.js') { response.setHeader('Content-Type', 'text/javascript'); response.end(javascript); return; }
  if (url.pathname === '/bundle.css') { response.setHeader('Content-Type', 'text/css'); response.end(css); return; }
  if (url.pathname.startsWith('/v1/')) {
    response.setHeader('Content-Type', 'application/json');
    const scenario = new URL(request.headers.referer ?? 'http://localhost').searchParams.get('scenario') ?? 'history';
    if (url.pathname === '/v1/responsibilities') {
      response.end(JSON.stringify({ responsibilities: [{ id: ids[0], objective: '매일 오전 자료를 조사하고 결과를 정리해 주세요.', state: 'active', trigger: { kind: 'daily', hour: 11, minute: 0, timezone: 'Asia/Seoul' }, next_review_at: '2026-10-06T02:00:00Z', last_error: null, last_action: { state: 'pending', task: null } }] })); return;
    }
    if (url.pathname === `/v1/responsibilities/${ids[0]}/history`) {
      const cursor = url.searchParams.get('cursor');
      const occurrence = requests.filter(item => item.scenario === scenario && item.cursor === cursor).length;
      requests.push({ scenario, cursor });
      if (errorScenarios[scenario]) {
        response.statusCode = errorScenarios[scenario].status;
        response.end(JSON.stringify({ error: { code: 'fixture_failure' } })); return;
      }
      if ((scenario === 'retry' && occurrence === 0) || (scenario === 'pages' && cursor && occurrence === 0)) {
        response.statusCode = 400; response.end(JSON.stringify({ error: { code: 'fixture_failure' } })); return;
      }
      const send = () => response.end(JSON.stringify({ runs: scenario === 'empty' ? [] : cursor ? [older] : runs, next_cursor: scenario === 'pages' && !cursor ? ids[4] : null }));
      if (scenario === 'loading') { release = send; return; }
      send(); return;
    }
    response.statusCode = 404; response.end('{}'); return;
  }
  response.setHeader('Content-Type', 'text/html');
  response.end('<!doctype html><html lang="ko"><meta charset="UTF-8"><meta name="viewport" content="width=device-width"><title>Schedule history fixture</title><link rel="stylesheet" href="/bundle.css"><body><main id="root" style="min-width:0;max-width:640px;margin:24px"></main><script type="module" src="/bundle.js"></script></body></html>');
});
server.listen(0, '127.0.0.1'); await once(server, 'listening');
const address = server.address(); assert.ok(address && typeof address === 'object');
const base = `http://127.0.0.1:${address.port}`;
if (process.argv.includes('--serve')) { console.log(`Schedule history fixture: ${base}/?scenario=history`); await new Promise(() => {}); }
const { loadDriver } = await import('./support/browser-driver.mjs');
const omowright = await loadDriver();
const profile = mkdtempSync(join(tmpdir(), 'schedule-history-'));
let browser;
const receipts = [];
async function waitFor(page, selector) {
  await page.evaluate(selector => new Promise((resolve, reject) => {
    if (document.querySelector(selector)) { resolve(); return; }
    const timeout = setTimeout(() => { observer.disconnect(); reject(new Error(`Missing ${selector}`)); }, 5000);
    const observer = new MutationObserver(() => { if (document.querySelector(selector)) { clearTimeout(timeout); observer.disconnect(); resolve(); } });
    observer.observe(document.body, { subtree: true, childList: true, attributes: true });
  }), selector);
}
async function assertNarrowLayout(page, scenario) {
  const layout = await page.evaluate(() => ({ scrollWidth: document.documentElement.scrollWidth, clientWidth: document.documentElement.clientWidth }));
  assert.equal(layout.clientWidth, 320);
  assert.ok(layout.scrollWidth <= layout.clientWidth, `${scenario}: horizontal overflow`);
  receipts.push({ scenario: `${scenario}-320-layout`, ...layout, passed: true });
}
try {
  browser = await omowright.connectPipe({ browserPath: '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome', browserArgs: ['--headless=new', '--no-first-run', `--user-data-dir=${profile}`], storageRoot: profile });
  for (const scenario of ['history', 'loading', 'retry', 'empty', 'pages', ...Object.keys(errorScenarios)]) {
    const page = await browser.newTab();
    await page.goto(`${base}/?scenario=${scenario}`);
    await omowright.emulate(page, { width: 320, height: 844, deviceScaleFactor: 1, mobile: true, hasTouch: true });
    await waitFor(page, '.schedule-list > li');
    assert.equal(requests.filter(item => item.scenario === scenario).length, 0, 'History is on demand');
    // The routine row opens in place; its 실행 기록 control loads history on demand.
    await page.locator('.schedule-main').first().click();
    assert.equal(requests.filter(item => item.scenario === scenario).length, 0, 'Opening the row does not load history');
    await page.locator('.schedule-detail button[aria-controls]').click();
    if (errorScenarios[scenario]) {
      await waitFor(page, '.schedule-history [role="alert"]');
      const message = await page.evaluate(() => document.querySelector('.schedule-history [role="alert"]').textContent);
      assert.equal(message, errorScenarios[scenario].message);
      await assertNarrowLayout(page, scenario);
      writeFileSync(join(evidence, `ui-${scenario}.png`), await page.screenshot());
      receipts.push({ scenario, message, passed: true });
      continue;
    }
    if (scenario === 'loading') {
      await waitFor(page, '.schedule-history [role="status"]');
      writeFileSync(join(evidence, 'ui-loading-pending.png'), await page.screenshot());
      assert.equal(typeof release, 'function'); release();
    }
    if (scenario === 'retry') {
      await waitFor(page, '.schedule-history [role="alert"]');
      assert.equal(await page.evaluate(() => document.querySelector('.schedule-history [role="alert"]').textContent), historyError);
      receipts.push({ scenario: 'initial-400-context', message: historyError, passed: true });
      writeFileSync(join(evidence, 'ui-error.png'), await page.screenshot());
      await assertNarrowLayout(page, 'initial-error');
      await page.locator('.schedule-history > div:has([role="alert"]) button').click();
    }
    if (scenario === 'empty') {
      await waitFor(page, '.schedule-history > p:not([role])');
      assert.equal(await page.evaluate(() => document.querySelectorAll('.schedule-history-list li').length), 0);
    } else {
      await waitFor(page, '.schedule-history-list li');
      const result = await page.evaluate(() => ({ dates: [...document.querySelectorAll('.schedule-history time')].map(node => node.dateTime), statuses: [...document.querySelectorAll('.schedule-history-meta > span')].map(node => node.textContent), links: document.querySelectorAll('.schedule-history-list button').length }));
      assert.deepEqual(result.dates, runs.map(run => run.scheduled_for));
      assert.deepEqual(result.statuses, ['시작 대기', '완료', '완료']);
      assert.equal(result.links, 2);
      await page.locator('.schedule-history-list li:nth-child(3) button').click();
      assert.deepEqual(await page.evaluate(() => window.openedTask), runs[2].task);
      if (scenario === 'pages') {
        await page.locator('.schedule-history > button').click();
        await waitFor(page, '.schedule-history [role="alert"]');
        assert.equal(await page.evaluate(() => document.querySelector('.schedule-history [role="alert"]').textContent), historyError);
        assert.equal(await page.evaluate(() => document.querySelectorAll('.schedule-history-list li').length), 3);
        writeFileSync(join(evidence, 'ui-pagination-error.png'), await page.screenshot());
        await assertNarrowLayout(page, 'pagination-error');
        receipts.push({ scenario: 'pagination-400-context', message: historyError, retainedRows: 3, passed: true });
        await page.locator('.schedule-history > div:has([role="alert"]) button').click();
        await waitFor(page, '.schedule-history-list li:nth-child(4)');
        assert.equal(await page.evaluate(() => document.querySelectorAll('.schedule-history > button').length), 0);
        assert.deepEqual(requests.filter(item => item.scenario === scenario).map(item => item.cursor), [null, ids[4], ids[4]]);
      }
      receipts.push({ scenario, result, navigation: runs[2].task.id, passed: true });
    }
    await assertNarrowLayout(page, scenario);
    writeFileSync(join(evidence, `ui-${scenario}.png`), await page.screenshot());
    writeFileSync(join(evidence, `ui-${scenario}.snapshot.json`), JSON.stringify(omowright.compactSnapshot(await page.snapshot()), null, 2));
    receipts.push({ scenario, passed: true });
  }
  writeFileSync(join(evidence, 'ui-results.json'), JSON.stringify({ receipts, requests }, null, 2));
  console.log(JSON.stringify({ passed: true, evidence, scenarios: 8 }, null, 2));
} finally {
  if (browser) await browser.close();
  server.closeAllConnections(); await new Promise(resolve => server.close(resolve));
  rmSync(profile, { recursive: true, force: true });
}
