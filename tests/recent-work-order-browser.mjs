import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { createServer } from 'node:http';
import { once } from 'node:events';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';

const baseline = process.argv.includes('--baseline');
const phase = baseline ? 'red' : 'green';
const evidence = resolve('.omo/evidence/recent-work-order', phase);
mkdirSync(evidence, { recursive: true });
const require = createRequire(import.meta.url);
const { build } = createRequire(require.resolve('wrangler/package.json'))('esbuild');
const ids = [1, 2, 3, 4, 5].map(n => `00000000-0000-4000-8000-${String(n).padStart(12, '0')}`);
const tasks = [
  { id: ids[0], objective: '오래된 진행 작업', state: 'running', created_at: '2026-10-01T00:00:00Z' },
  { id: ids[1], objective: '어제 완료 작업', state: 'succeeded', created_at: '2026-10-02T00:00:00Z' },
  { id: ids[2], objective: '최근 진행 작업', state: 'waiting', created_at: '2026-10-03T00:00:00Z' },
  { id: ids[3], objective: '최근 완료 작업', state: 'failed', created_at: '2026-10-03T00:00:00Z' },
].map(task => ({ ...task, reason: null, conversation_id: ids[4], updated_at: task.created_at }));
const conversations = tasks.map(task => ({ id: task.id, title: task.objective.replace('작업', '대화'), created_at: task.created_at }));
conversations.splice(2, 0, { id: ids[4], title: '현재 메시지', created_at: '2026-10-04T00:00:00Z' });
const bundle = await build({
  stdin: { contents: `
    import {createRoot} from 'react-dom/client';
    import {LazyMotion, domAnimation} from 'motion/react';
    import {WorkPanel} from './apps/web/src/WorkPanel';
    import {HistoryPanel} from './apps/web/src/HistoryPanel';
    import './apps/web/src/styles.css';
    import './apps/web/src/assistant.css';
    const tasks = Object.freeze(${JSON.stringify(tasks)}.map(Object.freeze));
    const conversations = Object.freeze(${JSON.stringify(conversations)}.map(Object.freeze));
    window.fixture = { tasks, conversations };
    createRoot(document.getElementById('root')).render(<LazyMotion features={domAnimation}>
      <WorkPanel tasks={tasks} onOpen={(task,_,destination)=>{window.openedTask=task.id;window.openedDestination=destination;}} onSource={()=>{}}/>
      <HistoryPanel conversations={conversations} assistantId="${ids[4]}" onOpen={id=>window.openedConversation=id}/>
    </LazyMotion>);
  `, resolveDir: process.cwd(), loader: 'tsx' },
  bundle: true, write: false, format: 'esm', platform: 'browser', jsx: 'automatic',
  nodePaths: [resolve('apps/web/node_modules')], outdir: 'out', loader: { '.woff2': 'dataurl', '.woff': 'dataurl' },
  plugins: baseline ? [{ name: 'frozen-baseline', setup(builder) {
    builder.onLoad({ filter: /\/(WorkPanel|HistoryPanel)\.tsx$/ }, ({ path }) => ({
      contents: readFileSync(resolve('.omo/evidence/recent-work-order/before', path.split('/').pop()), 'utf8'),
      loader: 'tsx', resolveDir: resolve('apps/web/src'),
    }));
  } }] : [],
});
const javascript = bundle.outputFiles.find(file => file.path.endsWith('.js'))?.text;
assert.ok(javascript);
const css = bundle.outputFiles.find(file => file.path.endsWith('.css'))?.text ?? '';
const server = createServer((request, response) => {
  if (request.url === '/bundle.js') { response.setHeader('Content-Type', 'text/javascript'); response.end(javascript); return; }
  if (request.url === '/bundle.css') { response.setHeader('Content-Type', 'text/css'); response.end(css); return; }
  response.setHeader('Content-Type', 'text/html');
  response.end('<!doctype html><html lang="ko"><meta charset="UTF-8"><meta name="viewport" content="width=device-width"><title>Recent list ordering regression</title><link rel="stylesheet" href="/bundle.css"><body><main id="root" style="max-width:720px;margin:24px"></main><script type="module" src="/bundle.js"></script></body></html>');
});
server.listen(0, '127.0.0.1'); await once(server, 'listening');
const address = server.address(); assert.ok(address && typeof address === 'object');
if (process.argv.includes('--serve')) {
  console.log(`Recent ordering fixture: http://127.0.0.1:${address.port}/`);
  await new Promise(() => {});
}
const { loadDriver } = await import('./support/browser-driver.mjs');
const omowright = await loadDriver();
const profile = mkdtempSync(join(tmpdir(), 'recent-work-order-'));
let browser;
const receipts = [];
try {
  browser = await omowright.connectPipe({ browserPath: '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome', browserArgs: ['--headless=new', '--no-first-run', `--user-data-dir=${profile}`], storageRoot: profile });
  const page = await browser.newTab(); await page.goto(`http://127.0.0.1:${address.port}`);
  const read = () => page.evaluate(() => ({
    // 맡긴 일 rows: 하고 있는 일 first, then 끝난 일 (the frozen baseline still renders .resource-item h3).
    tasks: [...document.querySelectorAll('.work-row .work-title, .resource-item h3')].map(node => node.textContent),
    active: [...document.querySelectorAll('section[aria-labelledby="work-active"] .work-title')].map(node => node.textContent),
    history: [...document.querySelectorAll('.history-link .history-title')].map(node => node.textContent),
    inputTasks: window.fixture.tasks.map(task => task.id),
    inputConversations: window.fixture.conversations.map(item => item.id),
  }));
  const initial = await read();
  const sorted = [tasks[2], tasks[3], tasks[1], tasks[0]].map(task => task.objective);
  // Work: what is still going on (newest first), then what finished (most recently finished first).
  const work = [tasks[2], tasks[0], tasks[3], tasks[1]].map(task => task.objective);
  assert.deepEqual(initial.tasks, baseline ? tasks.map(task => task.objective) : work);
  if (!baseline) assert.deepEqual(initial.active, [tasks[2].objective, tasks[0].objective]);
  assert.deepEqual(initial.history, (baseline ? tasks.map(task => task.objective) : sorted).map(title => title.replace('작업', '대화')));
  assert.deepEqual(initial.inputTasks, tasks.map(task => task.id));
  assert.deepEqual(initial.inputConversations, conversations.map(item => item.id));
  writeFileSync(join(evidence, 'initial.png'), await page.screenshot());
  writeFileSync(join(evidence, 'initial.snapshot.json'), JSON.stringify(omowright.compactSnapshot(await page.snapshot()), null, 2));
  await page.evaluate(() => document.querySelector('section[aria-label="이전 대화 기록"]').scrollIntoView());
  writeFileSync(join(evidence, 'history.png'), await page.screenshot());
  receipts.push({ scenario: 'mixed-state-lists-stable-ties-main-exclusion-input-immutability', observed: initial, newestFirst: !baseline });
  if (baseline) {
    assert.notDeepEqual(initial.tasks, sorted);
    assert.notDeepEqual(initial.history, sorted.map(title => title.replace('작업', '대화')));
  } else {
    // The whole row opens: a running task at its request, a finished one at its answer (failed: at its request).
    await page.locator(`.work-row[data-task-id="${ids[2]}"] .work-main`).click();
    assert.deepEqual(await page.evaluate(() => [window.openedTask, window.openedDestination]), [ids[2], 'request']);
    await page.locator(`.work-row[data-task-id="${ids[1]}"] .work-main`).click();
    assert.deepEqual(await page.evaluate(() => [window.openedTask, window.openedDestination]), [ids[1], 'reply']);
    await page.locator(`.work-row[data-task-id="${ids[3]}"] .work-main`).click();
    assert.deepEqual(await page.evaluate(() => [window.openedTask, window.openedDestination]), [ids[3], 'request']);
    writeFileSync(join(evidence, 'active.png'), await page.screenshot());
    await page.locator('.history-link').first().click();
    assert.equal(await page.evaluate(() => window.openedConversation), ids[2]);
    await page.locator('input[aria-label="이전 대화 검색"]').fill('완료');
    assert.deepEqual((await read()).history, ['최근 완료 대화', '어제 완료 대화']);
    writeFileSync(join(evidence, 'filtered.png'), await page.screenshot());
    receipts.push({ scenario: 'active-then-finished-sections-and-row-navigation', passed: true });
    receipts.push({ scenario: 'history-title-filter-retains-newest-first', passed: true });
  }
  writeFileSync(join(evidence, 'results.json'), JSON.stringify({ phase, receipts }, null, 2));
  console.log(JSON.stringify({ phase, passed: true, evidence }, null, 2));
} finally {
  if (browser) await browser.close();
  server.closeAllConnections(); await new Promise(resolve => server.close(resolve));
  rmSync(profile, { recursive: true, force: true });
  writeFileSync(join(evidence, 'cleanup.json'), JSON.stringify({ browserClosed: true, serverClosed: true, profileRemoved: true }));
}
process.exit(0);
