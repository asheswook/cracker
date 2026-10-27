import { expect, test } from "bun:test";
import { existsSync } from "node:fs";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { EventEmitter } from "node:events";
import { createContext, runInContext, type Context } from "node:vm";
import type { Browser } from "playwright-core";
import { appendDemonstrationStep, DemonstrationRecorder, DemonstrationSession, demonstrationUrl, minimizeText, normalizeStep, readDemonstration, type Recording, type Step } from "../services/daemon/demonstration.ts";
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
  expect(fake({ kind: "click", role: "link", tag: "a", text: "x".repeat(100), href: "https://user:pw@example.org/next?code=secret#token" })).toMatchObject({ text: "(…)", href: "https://example.org/next" });
  expect(fake({ kind: "submit", action: "https://example.org:8443/send?secret=yes" })).toMatchObject({ host: "example.org:8443" });
  expect(fake({ kind: "keydown", key: "Enter" })).toMatchObject({ key: "Enter" });
  expect(normalizeStep({ kind: "keydown", key: "a" }, url)).toBeNull();
  expect(normalizeStep({ kind: "unknown" }, url)).toBeNull();
  expect(demonstrationUrl("data:text/html,password=secret")).toBe("data:");
  expect(demonstrationUrl("invalid")).toBe("");
});

test("changes redact password types and all sensitive field metadata before truncation", () => {
  for (const metadata of [{ type: "password" }, { type: "email" }, { type: "tel" }, ...["token", "key", "secret", "api", "이메일", "email", "전화", "phone", "계좌", "account"].map(label => ({ label })), { name: "password" }, { id: "otp" }, { autocomplete: "one-time-code" }, { label: "인증번호" }, { label: "비밀번호" }, { name: "cardNumber" }, { id: "카드" }, { label: "CVC" }, { name: "ssn" }, { label: "주민등록번호" }, { name: "pw" }, { label: "x".repeat(100) + "password" }]) {
    const step = fake({ kind: "change", label: "Field", value: "typed-secret", ...metadata });
    expect(step).toMatchObject({ value: "(입력함)" });
    expect(JSON.stringify(step)).not.toContain("typed-secret");
  }
  expect(fake({ kind: "change", label: " Search  query ", value: "a".repeat(100) })).toMatchObject({ label: "Search query", value: "(…)" });
});

test("all stored text and URL paths minimize personal data and identifiers before truncation", () => {
  for (const sensitive of ["person@example.com", "010-1234-5678", "+82 10 1234 5678", "02-123-4567", "031 1234 5678", "1588-1234", "123456", "AbCdEf0123456789_-XYZ", "YWJjZGVmZ2hpamtsbW5vcHFycw==", "550e8400-e29b-41d4-a716-446655440000", "eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxMjM0NTY3ODkwIn0.signature"]) {
    expect(minimizeText(`Open ${sensitive} profile`)).toBe("Open (…) profile");
    expect(fake({ kind: "navigate", title: sensitive })).toMatchObject({ title: "(…)" });
    expect(fake({ kind: "click", text: sensitive, role: sensitive, tag: sensitive })).toMatchObject({ text: "(…)", role: "(…)", tag: "(…)" });
    expect(fake({ kind: "change", label: sensitive, value: sensitive })).toMatchObject({ label: "(…)" });
    expect(demonstrationUrl(`https://example.com/users/${encodeURIComponent(sensitive)}/edit`)).toBe("https://example.com/users/:id/edit");
  }
  expect(demonstrationUrl("https://example.com/orders/42/a9bcdef0/view?q=secret")).toBe("https://example.com/orders/:id/:id/view");
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
    expect(await recorder.stop()).toEqual({ steps });
    expect(await recorder.stop()).toEqual({ steps });
  } finally {
    await recorder.stop();
    await rm(directory, { recursive: true, force: true });
  }
});

test("worker stop waits for process exit, not merely its result line", async () => {
  const directory = await mkdtemp(join(tmpdir(), "demonstration-exit-"));
  const worker = join(directory, "worker.mjs"), marker = join(directory, "exited");
  await Bun.write(worker, `import {writeFileSync} from 'node:fs'; process.stdout.write('{"ready":true}\\n'); process.stdin.once('data', () => { process.stdout.write('{"steps":[],"truncated":true}\\n'); setTimeout(() => {writeFileSync(${JSON.stringify(marker)},'yes'); process.exit(0);},100); });`);
  const recorder = new DemonstrationRecorder(worker);
  try {
    await recorder.start("http://fake");
    expect(await recorder.stop()).toEqual({ steps: [], truncated: true });
    expect(existsSync(marker)).toBe(true);
  } finally { await recorder.stop(); await rm(directory, { recursive: true, force: true }); }
});

test("fake worker snapshots do not stop recording or resolve its final result", async () => {
  const directory = await mkdtemp(join(tmpdir(), "demonstration-snapshot-"));
  const worker = join(directory, "worker.mjs");
  const steps = [fake({ kind: "navigate", title: "Work" }), fake({ kind: "click", text: "Save" }), fake({ kind: "click", text: "Next" })];
  await Bun.write(worker, `
    import {createInterface} from 'node:readline';
    const steps=${JSON.stringify(steps)}; let count=2;
    process.stdout.write('{"ready":true}\\n');
    createInterface({input:process.stdin}).on('line', line => {
      if(line==='snapshot') {
        process.stdout.write(JSON.stringify({snapshot:true,steps:steps.slice(0,count)})+'\\n');
        count=3;
      } else if(line==='stop') {
        process.stdout.write(JSON.stringify({steps})+'\\n',()=>process.exit(0));
      }
    });
  `);
  const recorder = new DemonstrationRecorder(worker);
  try {
    await recorder.start("http://fake");
    const [first, concurrent] = await Promise.all([recorder.snapshot(), recorder.snapshot()]);
    expect(first).toEqual({ steps: steps.slice(0, 2) });
    expect(concurrent).toEqual(first);
    expect(await recorder.snapshot()).toEqual({ steps });
    expect(await recorder.stop()).toEqual({ steps });
    expect(await recorder.snapshot()).toEqual({ steps });
  } finally { await recorder.stop(); await rm(directory, { recursive: true, force: true }); }
});

test("session clears prior records, purges expired settings on startup/read, and preserves partial/truncated flags", async () => {
  const journal = new Journal(":memory:");
  const steps = [fake({ kind: "navigate", title: "Work" }), fake({ kind: "click", text: "Save" })];
  const old = { finished_at: new Date(Date.now() - 4 * 3600000).toISOString(), steps };
  let result: Recording = { steps }, starts = 0;
  const create = () => ({ start: async () => { starts++; }, snapshot: async () => result, stop: async () => result });
  try {
    journal.setLastDemonstration(JSON.stringify(old));
    const session = new DemonstrationSession(journal, create);
    expect(journal.lastDemonstration()).toBeNull();
    session.start(); await session.finish();
    const saved = await session.read();
    expect(saved).toMatchObject({ steps });
    await session.read(Date.now() + 4 * 3600000);
    expect(journal.lastDemonstration()).toBeNull();
    session.start(); await session.finish();
    session.start(); // Both the in-memory and persisted previous demonstration disappear now.
    result = { steps: [] };
    expect(journal.lastDemonstration()).toBeNull(); expect(await session.read()).toMatchObject({ in_progress: true });
    await session.finish();
    expect(await session.read()).toEqual({ none: true });
    result = { steps, truncated: true }; session.start(); await session.finish(true);
    expect(await session.read()).toMatchObject({ partial: true, truncated: true, steps });
    journal.setControl("user");
    result = { steps: steps.slice(0, 1) };
    const resumed = new DemonstrationSession(journal, create);
    expect(journal.lastDemonstration()).not.toBeNull();
    await resumed.finish();
    expect(await resumed.read()).toMatchObject({ partial: true, truncated: true });
    expect((await resumed.read() as { steps: Step[] }).steps).toHaveLength(3);
    expect(starts).toBe(5);
  } finally { journal.close(); }
});

test("live session reads and ten-minute idle checkpoints persist without returning control", async () => {
  const journal = new Journal(":memory:");
  const now = Date.now();
  const steps = [fake({ kind: "click", text: "Open" }, new Date(now).toISOString()), fake({ kind: "click", text: "Save" }, new Date(now).toISOString())];
  let result: Recording = { steps }, stops = 0;
  const session = new DemonstrationSession(journal, () => ({ start: async () => {}, snapshot: async () => result, stop: async () => { stops++; return result; } }));
  try {
    session.start();
    const live = await session.read(now);
    expect(live).toEqual({ steps, finished_at: new Date(now).toISOString(), in_progress: true });
    expect(readDemonstration(journal.lastDemonstration(), now)).toEqual({ steps, finished_at: new Date(now).toISOString(), partial: true });
    expect(stops).toBe(0);
    session.clearPrevious(); session.start(); // Test the idle-only path, without a tool read.
    await session.checkpointIdle(now + 9 * 60000);
    expect(journal.lastDemonstration()).toBeNull();
    await session.checkpointIdle(now + 11 * 60000);
    expect(readDemonstration(journal.lastDemonstration(), now + 11 * 60000)).toMatchObject({ steps, partial: true });
    const before = stops;
    result = { steps: [...steps, fake({ kind: "click", text: "Next" }, new Date(now + 11 * 60000).toISOString())] };
    const nextDeadline = await session.checkpointIdle(now + 15 * 60000);
    expect(nextDeadline).toBe(6 * 60000);
    expect(stops).toBe(before);
    expect((await session.read(now + 15 * 60000) as { steps: Step[] }).steps).toHaveLength(3);
    await session.finish();
    expect((await session.read() as { steps: Step[] }).steps).toHaveLength(3);
  } finally { await session.finish(); journal.close(); }
});

class FakeElement {
  constructor(readonly innerText = "Save") {}
  readonly tagName = "BUTTON";
  closest(selector: string) { return selector === "a" ? null : this; }
  getAttribute() { return null; }
}
class FakeFrame {
  readonly listeners = new Map<string, Set<(event: object) => void>>();
  readonly world: Context;
  evaluations = 0;
  constructor(private readonly address = "https://example.com/frame") {
    this.world = createContext({ window: {}, location: { href: address }, Element: FakeElement, HTMLElement: FakeElement,
      HTMLInputElement: class {}, HTMLSelectElement: class {}, HTMLTextAreaElement: class {}, HTMLFormElement: class {},
      document: {
        addEventListener: (name: string, handler: (event: object) => void) => { const set = this.listeners.get(name) ?? new Set(); set.add(handler); this.listeners.set(name, set); },
        removeEventListener: (name: string, handler: (event: object) => void) => this.listeners.get(name)?.delete(handler),
      },
    });
  }
  url() { return this.address; }
  async evaluate(fn: Function, args: unknown) {
    this.evaluations++;
    this.world["__args"] = args;
    return runInContext(`(${fn.toString()})(__args)`, this.world);
  }
  click(text: string, trusted = true) {
    for (const handler of this.listeners.get("click") ?? []) handler({ type: "click", target: new FakeElement(text), isTrusted: trusted });
  }
}
class FakePage extends EventEmitter {
  readonly frameList = [new FakeFrame("https://example.com/main"), new FakeFrame()];
  closed = false;
  isClosed() { return this.closed; }
  frames() { return this.frameList; }
  mainFrame() { return this.frameList[0]!; }
  async title() { return "Work"; }
  async addInitScript() {}
  async exposeBinding(name: string, callback: (source: { frame: FakeFrame }, raw: unknown) => void) {
    for (const frame of this.frames()) frame.world["window"][name] = async (raw: unknown) => callback({ frame }, raw);
  }
}
function fakeBrowser(page: FakePage) {
  const context = Object.assign(new EventEmitter(), { pages: () => page.closed ? [] : [page] });
  let closes = 0;
  const browser = { contexts: () => [context], close: async () => { closes++; } } as unknown as Browser;
  return { browser, context, closes: () => closes };
}

test("in-process snapshot is a copy and later actions remain recorded", async () => {
  const page = new FakePage(), fixture = fakeBrowser(page);
  const recorder = new DemonstrationRecorder(undefined, async () => fixture.browser);
  try {
    await recorder.start("http://fake");
    const child = page.frames()[1]!;
    child.click("Open"); child.click("Save");
    const snapshot = await recorder.snapshot();
    expect(snapshot.steps).toHaveLength(2);
    expect(fixture.closes()).toBe(0);
    snapshot.steps[0]!.url = "changed";
    snapshot.steps.pop();
    child.click("Next");
    const result = await recorder.stop();
    expect(result.steps).toHaveLength(3);
    expect(result.steps[0]!.url).toBe("https://example.com/frame");
    expect(result.steps.at(-1)).toMatchObject({ text: "Next" });
  } finally { await recorder.stop(); }
});

test("existing/navigated frames install once, synthetic events are ignored, and all frames clean up", async () => {
  const page = new FakePage(), fixture = fakeBrowser(page);
  const recorder = new DemonstrationRecorder(undefined, async () => fixture.browser);
  await recorder.start("http://fake");
  for (const frame of page.frames()) expect(frame.listeners.get("click")?.size).toBe(1);
  const child = page.frames()[1]!;
  page.emit("framenavigated", child); page.emit("framenavigated", child);
  await Promise.resolve();
  expect(child.listeners.get("click")?.size).toBe(1);
  child.click("Synthetic", false); child.click("Trusted");
  const result = await recorder.stop();
  expect(result.steps).toHaveLength(1);
  expect(result.steps[0]).toMatchObject({ kind: "click", text: "Trusted", url: "https://example.com/frame" });
  for (const frame of page.frames()) expect(frame.listeners.get("click")?.size).toBe(0);
  expect(fixture.closes()).toBe(1);
  const next = new DemonstrationRecorder(undefined, async () => fixture.browser);
  await next.start("http://fake");
  for (const frame of page.frames()) expect(frame.listeners.get("click")?.size).toBe(1);
  await next.stop();
});

test("300-step cap detaches every listener/CDP and closed pages are no longer tracked", async () => {
  const page = new FakePage(), fixture = fakeBrowser(page);
  const recorder = new DemonstrationRecorder(undefined, async () => fixture.browser);
  await recorder.start("http://fake");
  const child = page.frames()[1]!;
  for (let index = 0; index < 320; index++) child.click(`Action ${index}`);
  expect((await recorder.finished).truncated).toBe(true);
  const result = await recorder.stop();
  expect(result.steps).toHaveLength(300);
  expect(fixture.closes()).toBe(1);
  expect(page.listenerCount("framenavigated")).toBe(0);
  expect(fixture.context.listenerCount("page")).toBe(0);
  expect(child.listeners.get("click")?.size).toBe(0);
  const next = new DemonstrationRecorder(undefined, async () => fixture.browser);
  await next.start("http://fake");
  page.closed = true; page.emit("close");
  expect(page.listenerCount("framenavigated")).toBe(0);
  const before = child.evaluations;
  await next.stop();
  expect(child.evaluations).toBe(before);
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
    const result = await recorder.stop();
    const { steps } = result;
    expect(steps.some(step => step.kind === "navigate" && step.url === "data:")).toBe(true);
    expect(steps.some(step => step.kind === "click" && step.text === "Save")).toBe(true);
    expect(steps.some(step => step.kind === "change" && step.value === "(입력함)")).toBe(true);
    expect(JSON.stringify(steps)).not.toContain("never-record-this-password");
    // Reconnect verifies that stop only disconnected and that the page still works.
    expect(await automate(`console.log(await page.title()); await page.getByRole('button', {name:'Save'}).click();`)).toBe("Demo");
    expect(await recorder.stop()).toEqual(result);
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
