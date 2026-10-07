import { test, expect } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { atomicSecret } from "../packages/provider/credentials.ts";

test("credential lock serializes atomic updates across real processes", async () => {
  // Given independent Bun processes competing for one rotating record.
  const dir = await mkdtemp(join(tmpdir(), "credential-lock-")), path = join(dir, "record.json");
  await atomicSecret(path, { generation: 0 });
  const helper = join(dir, "increment.ts");
  await Bun.write(helper, `import { withCredentialLock } from ${JSON.stringify(resolve("packages/provider/credential-lock.ts"))};\nimport { atomicSecret } from ${JSON.stringify(resolve("packages/provider/credentials.ts"))};\nawait withCredentialLock(${JSON.stringify(path)}, async()=>{const current=await Bun.file(${JSON.stringify(path)}).json(); await atomicSecret(${JSON.stringify(path)}, {generation:current.generation+1});});\n`);
  // When
  const processes = Array.from({ length: 8 }, () => Bun.spawn([process.execPath, helper], { stdout: "pipe", stderr: "pipe" }));
  const exits = await Promise.all(processes.map(p => p.exited));
  // Then every process saw the previous rotation; none overwrote a newer record.
  try { expect(exits).toEqual(Array(8).fill(0)); expect(await Bun.file(path).json()).toEqual({ generation: 8 }); }
  finally { await rm(dir, { recursive: true }); }
});
