import { expect, test } from "bun:test";
import { execFile } from "node:child_process";
import { mkdtemp, readdir, readFile, readlink, rm, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import { saveDocument } from "../services/daemon/document-parser.ts";

test("downloads and hashes full original bytes with private permissions", async () => {
  const directory = await mkdtemp(join(tmpdir(), "document-download-")),
    path = join(directory, "input");
  const bytes = new Uint8Array(700000).fill(49),
    sha256 = new Bun.CryptoHasher("sha256").update(bytes).digest("hex");
  try {
    await saveDocument(
      new Blob([bytes]).stream(),
      { path, bytes: bytes.length, sha256 },
      new AbortController().signal,
    );
    expect(new Uint8Array(await readFile(path))).toEqual(bytes);
    expect((await stat(path)).mode & 0o777).toBe(0o600);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("closes a file descriptor even when the input stream and its cancellation reject", async () => {
  const directory = await mkdtemp(join(tmpdir(), "document-errored-")),
    path = join(directory, "input");
  const stream = new ReadableStream<Uint8Array>({
    start(controller) {
      controller.error(new TypeError("synthetic_transport_failure"));
    },
  });
  try {
    await expect(
      saveDocument(
        stream,
        { path, bytes: 1, sha256: "0".repeat(64) },
        new AbortController().signal,
      ),
    ).rejects.toThrow("synthetic_transport_failure");
    expect(stream.locked).toBe(false);
    if (process.platform === "linux") {
      const targets = await Promise.all(
        (await readdir("/proc/self/fd")).map(async (fd) => {
          try {
            return await readlink(`/proc/self/fd/${fd}`);
          } catch (error) {
            if (error instanceof Error && "code" in error && error.code === "ENOENT") return "";
            throw error;
          }
        }),
      );
      expect(targets).not.toContain(path);
    } else {
      const result = await promisify(execFile)("lsof", ["-p", String(process.pid), "-Fn"]);
      expect(result.stdout).not.toContain(path);
    }
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("rejects hash and length mismatch before parsing", async () => {
  const directory = await mkdtemp(join(tmpdir(), "document-integrity-"));
  try {
    for (const bytes of [0, 1, 3]) {
      await expect(
        saveDocument(
          new Blob(["ab"]).stream(),
          { path: join(directory, String(bytes)), bytes, sha256: "0".repeat(64) },
          new AbortController().signal,
        ),
      ).rejects.toThrow("integrity");
    }
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});
