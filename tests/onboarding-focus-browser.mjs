import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { createServer } from 'node:http';
import { once } from 'node:events';
import { join, resolve } from 'node:path';

const baseline = process.argv.includes('--baseline');
const requireVisible = process.argv.includes('--require-visible');
const phase = baseline ? (requireVisible ? 'red-contract' : 'red') : 'green';
const evidence = resolve(process.env.ONBOARDING_FOCUS_EVIDENCE ?? '.omo/evidence/ios-onboarding-focus', phase);
mkdirSync(evidence, { recursive: true });
const require = createRequire(import.meta.url);
const { build } = createRequire(require.resolve('wrangler/package.json'))('esbuild');
const { chromium } = await import(process.env.PLAYWRIGHT_MODULE ?? 'playwright');
const bundle = await build({
  stdin: { contents: `
    import {createRoot} from 'react-dom/client';
    import {LazyMotion, domAnimation} from 'motion/react';
    import {PersonaOnboarding} from './apps/web/src/settings/PersonaOnboarding';
    import './apps/web/src/styles.css';
    import './apps/web/src/assistant.css';
    import './apps/web/src/messenger.css';
    const root = createRoot(document.getElementById('root'));
    window.unmountOnboarding = () => root.unmount();
    root.render(<LazyMotion features={domAnimation}><PersonaOnboarding workspace="11111111-1111-4111-8111-111111111111"/></LazyMotion>);
  `, resolveDir: process.cwd(), loader: 'tsx' },
  bundle: true, write: false, format: 'esm', platform: 'browser', jsx: 'automatic',
  nodePaths: [resolve('apps/web/node_modules')], outdir: 'out', loader: { '.woff2': 'dataurl', '.woff': 'dataurl' },
  plugins: baseline ? [{ name: 'baseline', setup(builder) {
    builder.onLoad({ filter: /\/PersonaOnboarding\.tsx$/ }, () => ({
      contents: readFileSync('.omo/evidence/ios-onboarding-focus/before/PersonaOnboarding.tsx', 'utf8'),
      loader: 'tsx', resolveDir: resolve('apps/web/src/settings'),
    }));
  } }] : [],
});
const javascript = bundle.outputFiles.find(file => file.path.endsWith('.js'))?.text;
assert.ok(javascript);
const css = bundle.outputFiles.find(file => file.path.endsWith('.css'))?.text ?? '';
const requests = [];
const server = createServer((request, response) => {
  requests.push({ method: request.method, url: request.url });
  if (request.url === '/bundle.js') { response.setHeader('Content-Type', 'text/javascript'); response.end(javascript); return; }
  if (request.url === '/bundle.css') { response.setHeader('Content-Type', 'text/css'); response.end(css); return; }
  if (request.url === '/v1/settings' && request.method === 'GET') {
    response.setHeader('Content-Type', 'application/json');
    response.end(JSON.stringify({ revision: '77777777-7777-4777-8777-777777777777', persona: { name: 'Assistant', role: '', style: '' }, instructions: '', onboarding: { status: 'pending', updated_at: null } })); return;
  }
  if (request.url?.startsWith('/v1/')) { response.writeHead(405); response.end(); return; }
  response.setHeader('Content-Type', 'text/html');
  response.end(`<!doctype html><html lang="ko"><meta charset="UTF-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>Onboarding focus regression</title><link rel="stylesheet" href="/bundle.css"><body>
    <div class="assistant-shell"><main class="main-surface" style="height:100dvh"><section class="chat"><div class="message-feed"><div class="feed-content"><div id="root" class="onboarding-container"></div><div class="welcome"></div></div></div><div class="composer-region"><form class="composer messenger-composer"><div class="composer-input-row"><textarea aria-label="메시지" rows="1"></textarea></div></form></div></section></main></div>
    <script type="module" src="/bundle.js"></script></body></html>`);
});
server.listen(0, '127.0.0.1'); await once(server, 'listening');
const address = server.address(); assert.ok(address && typeof address === 'object');
const browser = await chromium.launch({ channel: 'chrome', headless: true });
const receipts = [];
const errors = [];
try {
  for (const width of [390, 768, 1280]) {
    const page = await browser.newPage({ viewport: { width, height: 844 }, hasTouch: width === 390, deviceScaleFactor: 1 });
    page.on('pageerror', error => errors.push(error.message));
    await page.goto(`http://127.0.0.1:${address.port}`);
    const field = page.getByRole('textbox', { name: '말투와 답변 방식', exact: true });
    await field.waitFor();
    const geometry = () => page.evaluate(() => {
      const field = document.querySelector('.persona-onboarding textarea:last-of-type[aria-labelledby$="-style"]');
      const feed = document.querySelector('.message-feed');
      const rect = field.getBoundingClientRect(), box = feed.getBoundingClientRect();
      return { focused: document.activeElement === field, value: field.value, start: field.selectionStart, end: field.selectionEnd,
        field: { top: rect.top, bottom: rect.bottom }, feed: { top: box.top, bottom: box.bottom, height: feed.clientHeight, scrollTop: feed.scrollTop, scrollHeight: feed.scrollHeight },
        viewport: innerHeight, windowScroll: scrollY,
        visible: rect.top >= box.top + parseFloat(getComputedStyle(feed).scrollPaddingTop) - 1 && rect.bottom <= box.bottom + 1 };
    });
    // Given: the lower field is focused, with no text entered, before the keyboard resize.
    await field.click();
    const before = await geometry();
    assert.equal(before.focused, true);
    assert.equal(before.value, '');
    // When: the usable viewport shrinks after focus, as in the native keyboard observation.
    await page.setViewportSize({ width, height: 490 });
    await page.evaluate(() => new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve))));
    const after = await geometry();
    await page.screenshot({ path: join(evidence, `${width}-focus-before-input.png`) });
    receipts.push({ scenario: 'focused-lower-field-visible-before-input-after-resize', width, before, after });
    writeFileSync(join(evidence, 'results.json'), JSON.stringify({ phase, receipts, errors }, null, 2));
    // Then: visibility changes without typing, focus/value/selection changes, or page scrolling.
    assert.equal(after.focused, true);
    assert.equal(after.value, '');
    assert.equal(after.start, before.start);
    assert.equal(after.end, before.end);
    assert.equal(after.windowScroll, 0);
    assert.equal(after.visible, !baseline || requireVisible, `focused field visibility at width ${width}`);
    if (!baseline) {
      assert.ok(after.feed.bottom - after.field.bottom >= 8, 'focused field clears the composer by 8px');
      await field.fill('alpha beta gamma');
      await field.evaluate(node => node.setSelectionRange(6, 10));
      await page.setViewportSize({ width, height: 450 });
      await page.evaluate(() => new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve))));
      const selected = await geometry();
      assert.equal(selected.visible, true);
      assert.deepEqual([selected.value, selected.start, selected.end], ['alpha beta gamma', 6, 10]);
      // Given a focused field, user scroll remains in charge between layout changes.
      await page.locator('.message-feed').evaluate(node => { node.scrollTop = 0; });
      await page.evaluate(() => new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve))));
      const scrolled = await geometry();
      assert.equal(scrolled.feed.scrollTop, 0);
      // Keyboard dismissal expands the viewport and must not snap back to focused content.
      await page.setViewportSize({ width, height: 844 });
      await page.evaluate(() => new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve))));
      const dismissed = await geometry();
      assert.equal(dismissed.feed.scrollTop, 0);
      assert.equal(dismissed.focused, true);
      assert.deepEqual([dismissed.value, dismissed.start, dismissed.end], ['alpha beta gamma', 6, 10]);
      await page.getByRole('textbox', { name: '메시지', exact: true }).click();
      await page.setViewportSize({ width, height: 490 });
      await page.evaluate(() => new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve))));
      assert.equal(await field.evaluate(node => document.activeElement === node), false);
      const outside = await geometry();
      assert.equal(outside.feed.scrollTop, 0);
      receipts.push({ scenario: 'selection-user-scroll-dismissal-and-composer-focus-preserved', width, selected, scrolled, dismissed, outside });
      await page.evaluate(() => window.unmountOnboarding());
      await page.setViewportSize({ width, height: 450 });
    }
    await page.close();
  }
  assert.deepEqual(errors, []);
  assert.equal(requests.some(request => request.method !== 'GET'), false);
  writeFileSync(join(evidence, 'results.json'), JSON.stringify({ phase, receipts, errors, requests, passed: true }, null, 2));
  console.log(JSON.stringify({ phase, passed: true, evidence }));
} finally {
  await browser.close();
  server.closeAllConnections(); await new Promise(resolve => server.close(resolve));
  writeFileSync(join(evidence, 'cleanup.json'), JSON.stringify({ browserClosed: true, serverClosed: true }));
}
