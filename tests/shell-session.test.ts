import { test, expect } from "bun:test";
import { mkdtemp, rm, realpath, mkdir } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { z } from "zod";
import { inflateSync } from "node:zlib";
import { ShellSessions } from "../services/daemon/shell-session.ts";
import { ToolExecutor } from "../services/daemon/tools.ts";

const Result = z.object({ session_id: z.string(), status: z.enum(["running", "exited"]), exit_code: z.number().nullable(), output: z.string(), remaining_output_chars: z.number(), dropped_output_chars: z.number(), tty: z.literal(false) });
const signal = () => new AbortController().signal;
async function drain(shell: ShellSessions, initial: string) {
  let result = Result.parse(JSON.parse(initial)), output = result.output, dropped = result.dropped_output_chars;
  for (let i = 0; i < 100 && (result.status === "running" || result.remaining_output_chars > 0); i++) {
    result = Result.parse(JSON.parse(await shell.run(JSON.stringify({ session_id: result.session_id, action: "poll", yield_ms: 1000, max_output_chars: 100000 }), signal())));
    output += result.output; dropped += result.dropped_output_chars;
  }
  expect(result.status).toBe("exited");
  return { ...result, output, dropped };
}

test("coding workflow creates files, exposes failed tests, patches and passes in explicit cwd", async () => {
  // Given a real isolated workspace and production tool dispatch.
  const dir = await mkdtemp(join(tmpdir(), "assistant-coding-")), tools = new ToolExecutor(); tools.setWorkspace(dir);
  const run = async (command: string) => {
    let result = Result.parse(JSON.parse((await tools.run("shell_start", JSON.stringify({ command, cwd: dir, yield_ms: 1000, max_output_chars: 16000 }), signal())).text));
    let output = result.output;
    while (result.status === "running" || result.remaining_output_chars) { result = Result.parse(JSON.parse((await tools.run("shell_session", JSON.stringify({ session_id: result.session_id, action: "poll", yield_ms: 1000, max_output_chars: 16000 }), signal())).text)); output += result.output; }
    return { ...result, output };
  };
  try {
    // When source and an executable test are written, tested, fixed and inspected through shell.
    await run("printf 'printf wrong\\n' > app.sh; printf '[ \"$(sh app.sh)\" = correct ]\\n' > test.sh");
    const failed = await run("sh test.sh");
    await run("printf 'printf correct\\n' > app.sh");
    const passed = await run("sh test.sh && sh app.sh > result.txt; cat app.sh result.txt; uname -s");
    // Then failed and successful exits reflect the actual files; output is publishable in OUTPUT_DIR.
    expect(failed.exit_code).not.toBe(0); expect(passed.exit_code).toBe(0);
    expect(passed.output).toContain("correct"); expect(await Bun.file(join(dir, "result.txt")).text()).toBe("correct");
    expect(tools.hasPendingShellSessions()).toBe(false);
    console.log(JSON.stringify({ scenario: "coding-workflow", os: process.platform, failed_exit: failed.exit_code, passed_exit: passed.exit_code, publishable_output: "correct" }));
  } finally { await tools.close(); await rm(dir, { recursive: true, force: true }); }
});

test("persistent pipe shell accepts stdin and preserves cwd across input calls", async () => {
  // Given an actual bash session with piped stdin.
  const shell = new ShellSessions(), dir = await mkdtemp(join(tmpdir(), "assistant-stdin-"));
  try {
    const started = Result.parse(JSON.parse(await shell.start(JSON.stringify({ command: "bash", yield_ms: 0 }), { workspace: dir, signal: signal() })));
    // When commands are supplied to the same live process.
    const output = await drain(shell, await shell.run(JSON.stringify({ session_id: started.session_id, action: "input", input: "mkdir nested; cd nested; printf '%s\\n' \"$PWD\"; exit\n" }), signal()));
    // Then the process state and output came from the changed directory.
    expect(output.output.trim()).toBe(await realpath(join(dir, "nested"))); expect(output.exit_code).toBe(0);
  } finally { await shell.close(); await rm(dir, { recursive: true, force: true }); }
});

test("streaming redaction withholds secrets split across interactive writes", async () => {
  // Given a synthetic token and a real persistent process.
  const previous = process.env["VM_TOKEN"]; process.env["VM_TOKEN"] = "synthetic-secret-chunk-boundary";
  const shell = new ShellSessions();
  try {
    const started = Result.parse(JSON.parse(await shell.start(JSON.stringify({ command: "bash", yield_ms: 0 }), { workspace: undefined, signal: signal() })));
    // When one secret is emitted in separate commands separated by model-visible reads.
    const first = Result.parse(JSON.parse(await shell.run(JSON.stringify({ session_id: started.session_id, action: "input", input: "printf synthetic-secret-\n", yield_ms: 50 }), signal())));
    const final = await drain(shell, await shell.run(JSON.stringify({ session_id: started.session_id, action: "input", input: "printf chunk-boundary; exit\n" }), signal()));
    // Then neither a secret prefix nor a full token reaches output.
    expect(first.output).toBe(""); expect(final.output).toBe("[REDACTED]");
  } finally { await shell.close(); if (previous === undefined) delete process.env["VM_TOKEN"]; else process.env["VM_TOKEN"] = previous; }
});

test("bounded output reports dropped characters and preserves paged output", async () => {
  // Given output exceeding the retained limit and an observable producer completion marker.
  const shell = new ShellSessions(), dir = await mkdtemp(join(tmpdir(), "assistant-output-"));
  try {
    const started = Result.parse(JSON.parse(await shell.start(JSON.stringify({ command: "head -c 1200000 /dev/zero | tr '\\0' x; touch ready; read line", yield_ms: 0 }), { workspace: dir, signal: signal() })));
    for (let i = 0; i < 200 && !(await Bun.file(join(dir, "ready")).exists()); i++) await Bun.sleep(10);
    expect(await Bun.file(join(dir, "ready")).exists()).toBe(true);
    // When the completed producer is allowed to exit and retained output is drained.
    const result = await drain(shell, await shell.run(JSON.stringify({ session_id: started.session_id, action: "input", input: "done\n" }), signal()));
    // Then every emitted character is delivered or explicitly counted as dropped.
    expect(started.output.length + result.output.length + started.dropped_output_chars + result.dropped).toBe(1200000);
    expect(result.dropped).toBeGreaterThan(0); expect(result.exit_code).toBe(0);
  } finally { await shell.close(); await rm(dir, { recursive: true, force: true }); }
});

test("task abort closes a yielded process group and invalidates IDs on reset", async () => {
  // Given a background shell which ignores TERM and owns a child.
  const shell = new ShellSessions(), controller = new AbortController();
  const started = Result.parse(JSON.parse(await shell.start(JSON.stringify({ command: "trap '' TERM; sleep 60 & echo $!; wait", yield_ms: 1000 }), { workspace: undefined, signal: controller.signal })));
  expect(started.status).toBe("running"); expect(shell.hasPending()).toBe(true);
  // When task cancellation occurs after the start call already returned.
  controller.abort(); await shell.close();
  // Then the session is gone and its child cannot be running (Linux may retain a zombie briefly).
  expect(shell.hasPending()).toBe(false);
  await expect(shell.run(JSON.stringify({ session_id: started.session_id, action: "poll" }), signal())).rejects.toThrow("shell_session_unknown_or_expired");
  const pid = Number(started.output.trim()); expect(pid).toBeGreaterThan(1);
  const ps = Bun.spawnSync(["ps", "-o", "stat=", "-p", String(pid)]);
  expect(ps.exitCode !== 0 || new TextDecoder().decode(ps.stdout).trim().startsWith("Z")).toBe(true);
});

test("interrupt terminates a long command and wrong session IDs are rejected", async () => {
  // Given a running command.
  const shell = new ShellSessions();
  try {
    const started = Result.parse(JSON.parse(await shell.start(JSON.stringify({ command: "echo ready; sleep 60", yield_ms: 1000 }), { workspace: undefined, signal: signal() })));
    expect(started.output).toContain("ready");
    // When the caller interrupts the process group.
    const final = await drain(shell, await shell.run(JSON.stringify({ session_id: started.session_id, action: "interrupt" }), signal()));
    // Then it exits and unrelated managers cannot access its session.
    expect(final.exit_code).not.toBe(0);
    await expect(new ShellSessions().run(JSON.stringify({ session_id: started.session_id, action: "poll" }), signal())).rejects.toThrow("shell_session_unknown_or_expired");
  } finally { await shell.close(); }
});

test("Python processes data and image files in the shared VM workspace", async () => {
  // Given real CSV and grayscale image input, without third-party Python packages.
  const dir = await mkdtemp(join(tmpdir(), "assistant-processing-")), shell = new ShellSessions();
  const program = `import csv, json, struct, zlib
from pathlib import Path
Path('data.csv').write_text('item,value\\na,3\\nb,5\\n')
Path('source.pgm').write_bytes(b'P5\\n2 2\\n255\\n' + bytes([0,64,128,255]))
with Path('data.csv').open() as source:
    total = sum(int(row['value']) for row in csv.DictReader(source))
pixels = Path('source.pgm').read_bytes().split(b'\\n',3)[3]
scanlines = b''.join(b'\\x00' + bytes(255-p for p in pixels[row:row+2]) for row in (0,2))
def chunk(kind, payload):
    return struct.pack('>I',len(payload))+kind+payload+struct.pack('>I',zlib.crc32(kind+payload))
image = b'\\x89PNG\\r\\n\\x1a\\n'+chunk(b'IHDR',struct.pack('>IIBBBBB',2,2,8,0,0,0,0))+chunk(b'IDAT',zlib.compress(scanlines))+chunk(b'IEND',b'')
Path('processed.png').write_bytes(image)
Path('summary.json').write_text(json.dumps({'total':total,'pixels':list(255-p for p in pixels)}))
print(Path('summary.json').read_text())
`;
  try {
    // When Python is created and run by the shell, then its outputs are inspected.
    const result = await drain(shell, await shell.start(JSON.stringify({ command: "cat > process.py <<'PY'\n" + program + "PY\npython3 process.py\n", cwd: dir }), { workspace: dir, signal: signal() }));
    // Then the actual data sum, transformed pixels and publishable PNG signature match.
    expect(result.exit_code).toBe(0); expect(JSON.parse(result.output)).toEqual({ total: 8, pixels: [255,191,127,0] });
    const png = Buffer.from(await Bun.file(join(dir, "processed.png")).arrayBuffer());
    expect(Array.from(png.subarray(0,8))).toEqual([137,80,78,71,13,10,26,10]);
    const idat = png.indexOf(Buffer.from("IDAT")), compressedLength = png.readUInt32BE(idat - 4);
    expect(Array.from(inflateSync(png.subarray(idat + 4, idat + 4 + compressedLength)))).toEqual([0,255,191,0,127,0]);
    const evidence = process.env["VM_EXECUTION_EVIDENCE_DIR"];
    if (evidence) { await mkdir(evidence, { recursive: true }); for (const name of ["processed.png", "summary.json", "process.py"]) await Bun.write(join(evidence, name), Bun.file(join(dir, name))); }
    console.log(JSON.stringify({ scenario: "python-data-image", os: process.platform, csv_sum: 8, png_signature_verified: true, inverted_pixels: [255,191,127,0] }));
  } finally { await shell.close(); await rm(dir, { recursive: true, force: true }); }
});

test.skipIf(process.platform !== "linux")("daemon death kills its yielded Linux command group", async () => {
  // Given a separate daemon-like process owning a shell session.
  const module = new URL("../services/daemon/shell-session.ts", import.meta.url).pathname;
  const child = Bun.spawn([process.execPath, "-e", `import {ShellSessions} from ${JSON.stringify(module)}; const shells=new ShellSessions(); console.log(await shells.start(JSON.stringify({command:'sleep 60 & echo $!; wait',yield_ms:1000}),{workspace:undefined,signal:new AbortController().signal})); await new Promise(()=>{});`], { stdout: "pipe", stderr: "pipe" });
  const reader = child.stdout.getReader();
  let line = "";
  while (!line.includes("\n")) { const chunk = await reader.read(); if (chunk.done) throw new Error("fixture exited before session"); line += new TextDecoder().decode(chunk.value); }
  const result = Result.parse(JSON.parse(line.trim())), pid = Number(result.output.trim()); expect(pid).toBeGreaterThan(1);
  // When the owner dies without cooperative cleanup.
  child.kill("SIGKILL"); await child.exited; reader.releaseLock();
  // Then the independent pidfd supervisor kills the group within the bounded deadline.
  let gone = false;
  for (let i = 0; i < 100 && !gone; i++) {
    const ps = Bun.spawnSync(["ps", "-o", "stat=", "-p", String(pid)]);
    gone = ps.exitCode !== 0 || new TextDecoder().decode(ps.stdout).trim().startsWith("Z");
    if (!gone) await Bun.sleep(10);
  }
  expect(gone).toBe(true);
});

test("stdin backpressure yields without blocking interrupt or close", async () => {
  // Given a process which does not read its stdin.
  const shell = new ShellSessions();
  try {
    const started = Result.parse(JSON.parse(await shell.start(JSON.stringify({ command: "sleep 60", yield_ms: 0 }), { workspace: undefined, signal: signal() })));
    // When more than a kernel pipe buffer is queued.
    const result = Result.parse(JSON.parse(await shell.run(JSON.stringify({ session_id: started.session_id, action: "input", input: "x".repeat(100000), yield_ms: 0 }), signal())));
    // Then the tool yields and remains closable instead of waiting for stdin consumption.
    expect(result.status).toBe("running");
  } finally { await shell.close(); }
}, 2000);
