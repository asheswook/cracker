import { expect, test } from "bun:test";
import { existsSync } from "node:fs";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { appendDemonstrationStep, DemonstrationRecorder, demonstrationUrl, normalizeStep, readDemonstration, type Step } from "../services/daemon/demonstration.ts";
import { Journal } from "../services/daemon/journal.ts";

const url = "https://example.com/work?token=secret#private";
const at = "2026-10-27T12:00:00.000Z";
const fake = (raw: unknown, timestamp = at): Step => {
  const step = normalizeStep(raw, url, timestamp);
  if (!step) throw new Error("Invalid fixture");
  return step;
};

test("normalizer allows only step fields and strips URL queries, fragments and credentials", () => {
  expect(fake({ kind: "navigate", title: "  Work   page ", secret: "discard" })).toEqual({ kind: "navigate", title: "Work page", timestamp: at, url: "https://example.com/work" });
  expect(fake({ kind: "click", role: "link", tag: "a", text: "x".repeat(100), href: "https://user:pw@example.org/next?code=secret#token" })).toMatchObject({ text: "x".repeat(80), href: "https://example.org/next" });
  expect(fake({ kind: "submit", action: "https://example.org:8443/send?secret=yes" })).toMatchObject({ host: "example.org:8443" });
  expect(fake({ kind: "keydown", key: "Enter" })).toMatchObject({ key: "Enter" });
  expect(normalizeStep({ kind: "keydown", key: "a" }, url)).toBeNull();
  expect(normalizeStep({ kind: "unknown" }, url)).toBeNull();
  expect(demonstrationUrl("data:text/html,password=secret")).toBe("data:");
  expect(demonstrationUrl("invalid")).toBe("");
});

test("changes redact password types and all sensitive field metadata before truncation", () => {
  for (const metadata of [{ type: "password" }, { name: "password" }, { id: "otp" }, { autocomplete: "one-time-code" }, { label: "인증번호" }, { label: "비밀번호" }, { name: "cardNumber" }, { id: "카드" }, { label: "CVC" }, { name: "ssn" }, { label: "주민등록번호" }, { name: "pw" }, { label: "x".repeat(100) + "password" }]) {
    const step = fake({ kind: "change", label: "Field", value: "typed-secret", ...metadata });
    expect(step).toMatchObject({ value: "(입력함)" });
    expect(JSON.stringify(step)).not.toContain("typed-secret");
  }
  expect(fake({ kind: "change", label: " Search  query ", value: "a".repeat(100) })).toMatchObject({ label: "Search query", value: "a".repeat(80) });
});

test("consecutive duplicates collapse regardless of timestamp and recording caps at 300", () => {
  const first = fake({ kind: "click", text: "Save" });
  const duplicate = fake({ kind: "click", text: "Save" }, "2026-10-27T12:00:01.000Z");
  const steps = appendDemonstrationStep([first], duplicate);
  expect(steps).toEqual([first]);
  expect(appendDemonstrationStep([...steps, fake({ kind: "click", text: "Next" })], duplicate)).toHaveLength(3);
  let many: Step[] = [];
  for (let index = 0; index < 350; index++) many = appendDemonstrationStep(many, fake({ kind: "change", label: "Search", value: String(index) }));
  expect(many).toHaveLength(300);
  expect(many.at(-1)).toMatchObject({ value: "299" });
});

test("reader expires after three hours, handles absent/corrupt records and reloads journal JSON", () => {
  const record = { finished_at: at, steps: [fake({ kind: "navigate", title: "Work" }), fake({ kind: "click", text: "Save" })] };
  const now = Date.parse(at);
  expect(readDemonstration(record, now + 3 * 60 * 60 * 1000)).toEqual(record);
  expect(readDemonstration(record, now + 3 * 60 * 60 * 1000 + 1)).toEqual({ none: true });
  for (const invalid of [null, undefined, "broken", {}, { ...record, finished_at: "invalid" }, { ...record, steps: [] }]) expect(readDemonstration(invalid, now)).toEqual({ none: true });
  const journal = new Journal(":memory:");
  try {
    expect(readDemonstration(journal.lastDemonstration(), now)).toEqual({ none: true });
    journal.setLastDemonstration(JSON.stringify(record));
    expect(readDemonstration(journal.lastDemonstration(), now)).toEqual(record);
  } finally { journal.close(); }
});

test("recorder start/stop exchanges steps with a fake Node worker and tolerates repeated stop", async () => {
  const directory = await mkdtemp(join(tmpdir(), "demonstration-fake-"));
  const worker = join(directory, "worker.mjs");
  const steps = [fake({ kind: "navigate", title: "Work" }), fake({ kind: "click", text: "Save" })];
  await Bun.write(worker, `process.stdout.write('{"ready":true}\\n'); process.stdin.once('data', () => { process.stdout.write(JSON.stringify({steps:${JSON.stringify(steps)}})+'\\n', () => process.exit(0)); });`);
  const recorder = new DemonstrationRecorder(worker);
  try {
    await recorder.start("http://fake-browser");
    expect(await recorder.stop()).toEqual(steps);
    expect(await recorder.stop()).toEqual(steps);
  } finally {
    await recorder.stop();
    await rm(directory, { recursive: true, force: true });
  }
});

const chrome = "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome";
test.skipIf(!existsSync(chrome) || !process.env["DEMONSTRATION_CHROME"])("optional Chrome CDP recording hides password and disconnect leaves pages open", async () => {
  const directory = await mkdtemp(join(tmpdir(), "demonstration-chrome-"));
  // Use the same Node worker as production; Playwright's CDP socket cannot run in Bun.
  const buildDirectory = await mkdtemp(join(import.meta.dir, "../node_modules/.demonstration-"));
  const build = await Bun.build({ entrypoints: [join(import.meta.dir, "../services/daemon/browser-mcp-entry.ts")], target: "node", packages: "external", outdir: buildDirectory, naming: "worker.mjs" });
  expect(build.success).toBe(true);
  const reservation = Bun.serve({ port: 0, fetch: () => new Response() });
  const port = reservation.port;
  await reservation.stop(true);
  const endpoint = `http://127.0.0.1:${port}`;
  const child = Bun.spawn([chrome, "--headless=new", `--remote-debugging-port=${port}`, `--user-data-dir=${directory}`, "--no-first-run", "--no-default-browser-check", "about:blank"], { stdout: "ignore", stderr: "pipe" });
  const recorder = new DemonstrationRecorder(join(buildDirectory, "worker.mjs"));
  const automate = async (code: string) => {
    const driver = Bun.spawn(["node", "--input-type=module", "-e", `
      import { chromium } from 'playwright-core';
      const browser = await chromium.connectOverCDP(${JSON.stringify(endpoint)}, {timeout:8000,noDefaults:true});
      try { const page = browser.contexts()[0].pages()[0]; ${code} } finally { await browser.close(); }
    `], { cwd: join(import.meta.dir, ".."), stdout: "pipe", stderr: "pipe" });
    const output = await new Response(driver.stdout).text();
    const errors = await new Response(driver.stderr).text();
    if (await driver.exited !== 0) throw new Error(errors);
    return output.trim();
  };
  try {
    let ready = false;
    for (let attempt = 0; attempt < 100; attempt++) {
      try { ready = (await fetch(`${endpoint}/json/version`, { signal: AbortSignal.timeout(500) })).ok; } catch { /* Chrome is starting. */ }
      if (ready || child.exitCode !== null) break;
      await Bun.sleep(100);
    }
    if (!ready) {
      child.kill();
      await child.exited;
      throw new Error(`Chrome CDP did not start: ${await new Response(child.stderr).text()}`);
    }
    await recorder.start(endpoint);
    await automate(`
      await page.goto('data:text/html,' + encodeURIComponent('<title>Demo</title><button>Save</button><label>Password<input type="password" name="password"></label><input name="search">'));
      await page.getByRole('button', {name:'Save'}).click();
      await page.locator('input[type="password"]').fill('never-record-this-password');
      await page.locator('input[name="search"]').focus();
      await new Promise(resolve => setTimeout(resolve, 100));
    `);
    const steps = await recorder.stop();
    expect(steps.some(step => step.kind === "navigate" && step.url === "data:")).toBe(true);
    expect(steps.some(step => step.kind === "click" && step.text === "Save")).toBe(true);
    expect(steps.some(step => step.kind === "change" && step.value === "(입력함)")).toBe(true);
    expect(JSON.stringify(steps)).not.toContain("never-record-this-password");
    // Reconnect verifies that stop only disconnected and that the page still works.
    expect(await automate(`console.log(await page.title()); await page.getByRole('button', {name:'Save'}).click();`)).toBe("Demo");
    expect(await recorder.stop()).toEqual(steps);
  } catch (error) {
    child.kill();
    await child.exited;
    throw new Error(`${String(error)}\nChrome: ${(await new Response(child.stderr).text()).slice(0, 2000)}`);
  } finally {
    await recorder.stop();
    child.kill();
    await child.exited;
    await rm(directory, { recursive: true, force: true });
    await rm(buildDirectory, { recursive: true, force: true });
  }
}, 30000);
