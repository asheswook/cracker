// The omo browser skill (omowright) when it is installed, else the same small surface over the repo's playwright-core,
// so these browser tests run on any machine with Chrome.
import { existsSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';

const skills = [
  process.env.OMO_BROWSER_SKILL_ROOT,
  join(homedir(), '.codex/plugins/cache/sisyphuslabs/omo/5.1.7/skills/browser'),
].filter(Boolean);

export async function loadDriver() {
  for (const root of skills) {
    const script = join(root, 'scripts/omowright.mjs');
    if (existsSync(script)) { const { loadOmowright } = await import(script); return (await loadOmowright()).omowright; }
  }
  const { chromium } = await import('playwright-core');
  const wrap = context => ({
    async newTab(url) { const page = await context.newPage(); page.snapshot = () => page.locator('body').ariaSnapshot(); if (url) await page.goto(url); return page; },
    close: () => context.browser()?.close() ?? context.close(),
  });
  return {
    async connectPipe({ browserPath, browserArgs = [] }) {
      const headless = browserArgs.some(a => a.startsWith('--headless'));
      const args = browserArgs.filter(a => !a.startsWith('--headless') && !a.startsWith('--user-data-dir'));
      const browser = await chromium.launch({ executablePath: browserPath, headless, args });
      return wrap(await browser.newContext());
    },
    repinViewport: (page, size) => page.setViewportSize(size),
    // Viewport only: touch/mobile emulation needs a new context in playwright; layout checks only need the width.
    emulate: (page, { width, height }) => page.setViewportSize({ width, height }),
    compactSnapshot: snapshot => snapshot,
  };
}
