import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { chmod, copyFile, mkdir, mkdtemp, readFile, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { z } from "zod";
import type { parseDocument as productionParse } from "../services/daemon/document-parser.ts";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const fixture = join(root, "tests/fixtures/document-process");
const evidence = resolve(z.string().min(1).parse(process.argv[2]));
assert.equal(process.platform, "linux", "Linux-only: no skipped scenario is a pass");
await mkdir(evidence, { recursive: true, mode: 0o700 });
const results: unknown[] = [];
const owned = new Map<number, string>();
const controllers = new Set<AbortController>();
let temporary: string | undefined;
let deadlineExpired = false;
const watchdog = setTimeout(async () => {
  deadlineExpired = true;
  for (const controller of controllers) controller.abort();
  for (const [pid, originalIdentity] of owned) {
    const current = await stat(pid);
    if (!current || identity(current) !== originalIdentity) continue;
    try { process.kill(pid, "SIGKILL"); }
    catch (error) { if (!(error instanceof Error && "code" in error && error.code === "ESRCH")) throw error; }
  }
}, 100000);

async function stat(pid: number): Promise<string | null> {
  try { return await readFile(`/proc/${pid}/stat`, "utf8"); }
  catch (error) {
    if (error instanceof Error && "code" in error && error.code === "ENOENT") return null;
    throw error;
  }
}
const identity = (value: string): string => value.slice(value.lastIndexOf(")") + 2).split(" ")[19] ?? "";
async function waitFor(check: () => Promise<boolean>, timeout: number, label: string): Promise<void> {
  const end = Date.now() + timeout;
  while (!await check()) {
    assert(!deadlineExpired && Date.now() < end, `deadline: ${label}`);
    await Bun.sleep(25);
  }
}
async function observe(pids: readonly number[]): Promise<readonly string[]> {
  const observations: string[] = [];
  for (const pid of pids) {
    const value = await stat(pid);
    assert(value, `fixture PID ${pid} must exist before trigger`);
    assert(!value.slice(value.lastIndexOf(")") + 2).startsWith("Z"), "fixture must be alive");
    owned.set(pid, identity(value)); observations.push(value.trim());
  }
  return observations;
}
async function assertReaped(pids: readonly number[]): Promise<void> {
  await waitFor(async () => (await Promise.all(pids.map(stat))).every(value => value === null), 5000, "all fixture PIDs reaped (zombies fail)");
  for (const pid of pids) owned.delete(pid);
}
const Pids = z.object({ supervisor: z.number().int().gt(1), extractor: z.number().int().gt(1), descendant: z.number().int().gt(1) }).strict();
async function ready(input: string): Promise<readonly number[]> {
  await waitFor(() => Bun.file(`${input}.pids`).exists(), 5000, "fixture startup");
  const pids = Pids.parse(JSON.parse(await readFile(`${input}.pids`, "utf8")));
  return [pids.supervisor, pids.extractor, pids.descendant];
}

try {
  const membership = (await readFile("/proc/self/cgroup", "utf8")).split("\n").find(line => line.startsWith("0::"))?.slice(3);
  assert(membership && !membership.includes(".."), "cgroup v2 required");
  const cgroup = `/sys/fs/cgroup${membership}`;
  const constraints = await Promise.all(["cpu.max", "memory.max", "pids.max"].map(name => readFile(join(cgroup, name), "utf8")));
  const [quota, period] = (constraints[0] ?? "").trim().split(/\s+/).map(Number);
  assert(quota && period && quota / period <= 0.2, "CPU quota must be at most 20%");
  assert(Number(constraints[1]) > 0 && Number(constraints[1]) <= 268435456, "memory.max must be <=256MiB");
  assert(Number(constraints[2]) > 0 && Number(constraints[2]) <= 16, "pids.max must be <=16");
  results.push({ scenario: "cgroup-precondition", constraints: constraints.map(value => value.trim()) });
  temporary = await mkdtemp(join(tmpdir(), "document-bounds-"));
  await chmod(temporary, 0o700);
  await symlink(join(root, "node_modules"), join(temporary, "node_modules"));
  const hashes: Record<string, string> = {};
  for (const name of ["document-parser.ts", "shell-supervisor.py"]) {
    const source = join(root, "services/daemon", name), target = join(temporary, name);
    await copyFile(source, target);
    const original = await readFile(source), copied = await readFile(target);
    assert(original.equals(copied), "copied production module must be byte-identical");
    hashes[name] = createHash("sha256").update(original).digest("hex");
  }
  hashes["document-extract.py"] = createHash("sha256").update(await readFile(join(root, "services/daemon/document-extract.py"))).digest("hex");
  await copyFile(join(fixture, "synthetic-extract.py"), join(temporary, "document-extract.py"));
  const parser: { readonly parseDocument: typeof productionParse } = await import(pathToFileURL(join(temporary, "document-parser.ts")).href);
  results.push({ scenario: "source-identity", hashes, syntheticExtractor: true });
  for (const scenario of ["abort", "wall-timeout", "stdout", "stderr"] as const) {
    // Given a real production parser/supervisor with a synthetic extractor and live descendant.
    const input = join(temporary, scenario);
    await writeFile(input, scenario === "stdout" || scenario === "stderr" ? scenario : "hang");
    const controller = new AbortController(); controllers.add(controller);
    const started = Date.now();
    const pending: Promise<{ readonly value: Awaited<ReturnType<typeof productionParse>> | null; readonly error: unknown }> = parser.parseDocument({ format: "pdf", path: input, directory: temporary }, controller.signal)
      .then(value => ({ value, error: null }), (error: unknown) => ({ value: null, error }));
    try {
      const pids = await ready(input), before = await observe(pids);
      await writeFile(join(evidence, `${scenario}-before.json`), JSON.stringify({ pids, before }));
      // When cancellation, the unchanged wall deadline, or an actual output overflow occurs.
      await writeFile(`${input}.go`, "go");
      if (scenario === "abort") controller.abort();
      const outcome = await pending;
      results.push({ scenario, observedOutcome: outcome.error instanceof Error ? { name: outcome.error.name, code: "code" in outcome.error ? outcome.error.code : null } : outcome.value });
      // Then the caller sees the intended outcome and every observed PID disappears, including zombies.
      if (scenario === "abort") {
        assert(outcome.error instanceof Error && "code" in outcome.error && outcome.error.code === "aborted");
      } else {
        assert.equal(outcome.error, null);
        assert.deepEqual(outcome.value, { kind: "complete", text: null, truncated: false, code: "resource_limit" });
      }
      if (scenario === "wall-timeout") assert(Date.now() - started >= 14500, "wall timeout must actually elapse");
      await assertReaped(pids);
      const record = { scenario, pass: true, elapsedMs: Date.now() - started, pids, procEntriesAbsent: true };
      results.push(record); console.log(JSON.stringify(record));
    } finally { controller.abort(); await pending; controllers.delete(controller); }
  }
  {
    // Given a disposable Python parent owning the real supervisor and synthetic process tree.
    const input = join(temporary, "parent-death"); await writeFile(input, "hang");
    const parent = Bun.spawn(["/usr/bin/python3", "-I", join(fixture, "parent-owner.py"), join(temporary, "shell-supervisor.py"), join(temporary, "document-extract.py"), input], { cwd: temporary, stdout: "ignore", stderr: "pipe", env: { PATH: "/usr/bin:/bin" } });
    await observe([parent.pid]);
    try {
      const pids = await ready(input), before = await observe(pids);
      await writeFile(join(evidence, "parent-death-before.json"), JSON.stringify({ parent: parent.pid, pids, before }));
      await writeFile(`${input}.go`, "go");
      // When the owner dies without cooperative cleanup.
      parent.kill("SIGKILL"); await parent.exited;
      // Then pidfd detection terminates and reaps the complete supervised tree.
      await assertReaped([parent.pid, ...pids]);
      const record = { scenario: "parent-death", pass: true, pids, procEntriesAbsent: true };
      results.push(record); console.log(JSON.stringify(record));
    } finally { parent.kill("SIGKILL"); await parent.exited; }
  }
  for (const mode of ["address-space", "cpu"] as const) {
    // Given exact production extractor initialization (runpy does not call main).
    const child: Bun.Subprocess<"ignore", "pipe", "pipe"> = Bun.spawn(["/usr/bin/python3", "-I", join(fixture, "limit-probe.py"), join(root, "services/daemon/document-extract.py"), mode], { cwd: temporary, stdin: "ignore", stdout: "pipe", stderr: "pipe", env: { PATH: "/usr/bin:/bin" } });
    await observe([child.pid]);
    const timeout = setTimeout(() => child.kill("SIGKILL"), 25000);
    try {
      // When a workload exceeds the actual configured CPU or virtual-address-space limit.
      const [code, stdout, stderr] = await Promise.all([child.exited, new Response(child.stdout).text(), new Response(child.stderr).text()]);
      results.push({ scenario: `production-rlimit-${mode}-observed`, code, signal: child.signalCode, stdout, stderr });
      const lines = stdout.trim().split("\n");
      const limits = z.object({ cpu: z.tuple([z.literal(2), z.literal(3)]), address_space: z.tuple([z.literal(134217728), z.literal(134217728)]) }).parse(JSON.parse(lines[0] ?? ""));
      // Then allocation fails or the kernel sends SIGXCPU; watchdog SIGKILL cannot pass.
      if (mode === "cpu") assert.equal(child.signalCode, "SIGXCPU");
      else { assert.equal(code, 0); assert.equal(lines[1], "address_space_allocation_rejected"); }
      assert.equal(stderr, ""); await assertReaped([child.pid]);
      const record = { scenario: `production-rlimit-${mode}`, pass: true, code, signal: child.signalCode, limits, stdout };
      results.push(record); console.log(JSON.stringify(record));
    } finally { clearTimeout(timeout); child.kill("SIGKILL"); await child.exited; }
  }
  assert(!deadlineExpired, "overall deadline expired");
  results.push({ scenario: "all", pass: true });
} catch (error) {
  if (!(error instanceof Error)) throw error;
  results.push({ scenario: "failure", pass: false, name: error.name, message: error.message });
  process.exitCode = 1;
} finally {
  clearTimeout(watchdog);
  for (const controller of controllers) controller.abort();
  const emergency: number[] = [];
  for (const [pid, originalIdentity] of owned) {
    const current = await stat(pid);
    if (current && identity(current) === originalIdentity) {
      emergency.push(pid);
      try { process.kill(pid, "SIGKILL"); }
      catch (error) { if (!(error instanceof Error && "code" in error && error.code === "ESRCH")) throw error; }
    }
  }
  if (emergency.length) {
    results.push({ scenario: "emergency-cleanup", pass: false, pids: emergency }); process.exitCode = 1;
    const end = Date.now() + 5000;
    while (Date.now() < end && (await Promise.all(emergency.map(stat))).some(value => value !== null)) await Bun.sleep(25);
    results.push({ scenario: "emergency-cleanup-after", remaining: await Promise.all(emergency.map(async pid => ({ pid, stat: await stat(pid) }))) });
  }
  if (temporary) await rm(temporary, { recursive: true, force: true });
  await writeFile(join(evidence, "results.json"), JSON.stringify(results, null, 2));
}
