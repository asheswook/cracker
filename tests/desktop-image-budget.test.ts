import { expect, test } from "bun:test";
import { execFile } from "node:child_process";
import { chmod, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import { DesktopApi } from "../services/daemon/desktop-api";

const command = promisify(execFile);
test("rejects aggregate screenshot bytes even when each PNG is individually within the limit", async () => {
  // Given a real PNG whose random RGB pixels occupy slightly over 4MiB.
  const directory = await mkdtemp(join(tmpdir(), "desktop-image-budget-"));
  const png = join(directory, "noise.png");
  await command("python3", [
    "-c",
    `import os,struct,zlib,binascii,sys
w,h=1024,1366
def chunk(t,d): return struct.pack('>I',len(d))+t+d+struct.pack('>I',binascii.crc32(t+d)&0xffffffff)
raw=b''.join(b'\\0'+os.urandom(w*3) for _ in range(h))
open(sys.argv[1],'wb').write(b'\\x89PNG\\r\\n\\x1a\\n'+chunk(b'IHDR',struct.pack('>IIBBBBB',w,h,8,2,0,0,0))+chunk(b'IDAT',zlib.compress(raw))+chunk(b'IEND',b''))`,
    png,
  ]);
  await Bun.write(join(directory, "scrot"), `#!/bin/sh\nexec /bin/cp '${png}' "$1"\n`);
  await chmod(join(directory, "scrot"), 0o700);
  const previousPath = process.env["PATH"];
  process.env["PATH"] = directory;
  try {
    const api = new DesktopApi(() => {}, directory);
    const first = await api.capture();
    expect(first.width).toBe(1024);
    expect(first.height).toBe(1366);
    // When a second individually valid capture exceeds the shared batch budget.
    await expect(api.capture()).rejects.toThrow("screenshot_too_large");
    // Then the first capture proves this was the aggregate, not per-image limit.
    expect(Bun.file(png).size).toBeGreaterThan(4 * 1024 * 1024);
    expect(Bun.file(png).size).toBeLessThan(8 * 1024 * 1024);
  } finally {
    if (previousPath === undefined) delete process.env["PATH"];
    else process.env["PATH"] = previousPath;
    await rm(directory, { recursive: true, force: true });
  }
});
