import { expect, test } from "bun:test";
import { mkdtemp, readdir, readFile, rm } from "node:fs/promises";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import ky from "ky";
import { DocumentResult } from "../packages/artifacts/document-types.ts";
import { runIndexer } from "../services/daemon/artifact-indexer.ts";

async function wireScenario(chunked: boolean) {
  const directory = await mkdtemp(join(tmpdir(), "document-wire-"));
  const bytes = new Uint8Array(
    await Bun.file("tests/fixtures/documents/ordinary.pdf").arrayBuffer(),
  );
  const job = {
    artifact_id: crypto.randomUUID(),
    lease_id: crypto.randomUUID(),
    version: 1,
    format: "pdf",
    bytes: bytes.length + (chunked ? 0 : 1),
    sha256: new Bun.CryptoHasher("sha256").update(bytes).digest("hex"),
  };
  const controller = new AbortController();
  const receipt = Promise.withResolvers<{
    readonly result: ReturnType<typeof DocumentResult.parse>;
    readonly savedHash: string | null;
    readonly expectedHash: string;
  }>();
  let offered = false;
  const server = createServer(async (request, response) => {
    const path = request.url ?? "";
    if (path.endsWith("/claim")) {
      const value = offered ? null : job;
      offered = true;
      response.end(JSON.stringify({ job: value }));
      return;
    }
    if (path.endsWith("/content")) {
      if (!chunked) {
        response.setHeader("Content-Length", bytes.length);
        response.end(bytes);
        return;
      }
      response.write(bytes.subarray(0, 100));
      response.end(bytes.subarray(100));
      return;
    }
    if (path.endsWith("/lease")) {
      response.end(JSON.stringify({ continue: true }));
      return;
    }
    if (path.endsWith("/result")) {
      let body = "";
      for await (const part of request) body += String(part);
      const owned = (await readdir(directory))[0];
      const saved = owned
        ? await readFile(join(directory, owned, "input")).catch((error) => {
            if (error instanceof Error && "code" in error && error.code === "ENOENT") return null;
            throw error;
          })
        : null;
      receipt.resolve({
        result: DocumentResult.parse(JSON.parse(body)),
        savedHash: saved ? new Bun.CryptoHasher("sha256").update(saved).digest("hex") : null,
        expectedHash: job.sha256,
      });
      response.end(JSON.stringify({ accepted: true }));
      return;
    }
    response.statusCode = 404;
    response.end();
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("Missing HTTP address");
  const previous = {
    url: process.env["CONTROL_URL"],
    token: process.env["VM_TOKEN"],
    root: process.env["DOCUMENT_TEMP_ROOT"],
  };
  process.env["CONTROL_URL"] = `http://127.0.0.1:${address.port}`;
  process.env["VM_TOKEN"] = "synthetic-document-transport-token";
  process.env["DOCUMENT_TEMP_ROOT"] = directory;
  const running = runIndexer(controller.signal);
  void running.catch((error) => receipt.reject(error));
  try {
    const probe = await ky.get(`http://127.0.0.1:${address.port}/content`);
    expect(probe.headers.get("Content-Length")).toBe(chunked ? null : String(bytes.length));
    if (chunked) expect(probe.headers.get("Transfer-Encoding")).toBe("chunked");
    await probe.arrayBuffer();
    return await receipt.promise;
  } finally {
    controller.abort();
    await running;
    expect(await readdir(directory)).toEqual([]);
    server.closeAllConnections();
    server.close();
    for (const [key, value] of [
      ["CONTROL_URL", previous.url],
      ["VM_TOKEN", previous.token],
      ["DOCUMENT_TEMP_ROOT", previous.root],
    ] as const) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
    await rm(directory, { recursive: true, force: true });
  }
}

test("accepts a real chunked HTTP body and saves the exact original before parser completion", async () => {
  const receipt = await wireScenario(true);
  expect(receipt.savedHash).toBe(receipt.expectedHash);
  expect(receipt.result.kind).not.toBe("yield");
  if (receipt.result.kind !== "yield") expect(receipt.result.code).not.toBe("integrity");
});

test("rejects a present Content-Length that differs from leased original size", async () => {
  const receipt = await wireScenario(false);
  expect(receipt.savedHash).toBeNull();
  expect(receipt.result.kind).toBe("retry");
  if (receipt.result.kind !== "yield") expect(receipt.result.code).toBe("integrity");
});
