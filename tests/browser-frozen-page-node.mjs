// Run under Node (Playwright's CDP socket does not work in Bun):
//   bun build services/daemon/browser-mcp.ts --target=node --packages=external --outfile=/tmp/browser-mcp-test.mjs
//   node tests/browser-frozen-page-node.mjs /tmp/browser-mcp-test.mjs
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { chromium } from "playwright-core";

const { closeFrozenPages } = await import(pathToFileURL(resolve(process.argv[2])).href);
const chrome = process.env.CHROME_PATH ?? "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome";
const profile = mkdtempSync(join(tmpdir(), "frozen-page-"));
const port = 9400 + Math.floor(Math.random() * 400), endpoint = `http://127.0.0.1:${port}`;
const child = spawn(chrome, ["--headless=new", `--remote-debugging-port=${port}`, `--user-data-dir=${profile}`, "--no-first-run", "--site-per-process", "about:blank"], { stdio: "ignore" });
try {
  for (let i = 0; ; i++) { try { await fetch(`${endpoint}/json/version`); break; } catch { if (i > 50) throw new Error("Chrome did not start"); await new Promise(r => setTimeout(r, 100)); } }
  // Given: a healthy page and one whose renderer never yields (separate process so only that tab freezes)
  const open = async url => (await fetch(`${endpoint}/json/new?${encodeURIComponent(url)}`, { method: "PUT" })).json();
  await open("data:text/html,<title>healthy</title>");
  const frozen = await open("data:text/html,<title>frozen</title><script>setTimeout(()=>{for(;;){}},200)</script>");
  assert.ok(frozen.id);
  await new Promise(r => setTimeout(r, 1000));
  await assert.rejects(chromium.connectOverCDP(endpoint, { timeout: 3000 }), /Timeout/, "precondition: the frozen page blocks attaching");
  // When
  const closed = await closeFrozenPages(endpoint, 1500);
  // Then
  assert.equal(closed.length, 1);
  const browser = await chromium.connectOverCDP(endpoint, { timeout: 8000 });
  const titles = await Promise.all(browser.contexts()[0].pages().map(page => page.title()));
  assert.ok(titles.includes("healthy")); assert.ok(!titles.includes("frozen"));
  await browser.close();
  console.log("PASS frozen page closed; attach recovers", titles);
} finally { child.kill(); await new Promise(r => setTimeout(r, 500)); rmSync(profile, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 }); }
