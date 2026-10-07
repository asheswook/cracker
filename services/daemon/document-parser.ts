import { spawn } from "node:child_process";
import { createHash } from "node:crypto";
import { open } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { z } from "zod";

export const documentOutcomeSchema = z.object({
  kind: z.literal("complete"), text: z.string().max(200000).nullable(), truncated: z.boolean(),
  code: z.enum(["text", "empty", "signature_mismatch", "encrypted_or_malformed", "encrypted", "malformed", "unsupported", "resource_limit", "input_limit", "parser_unavailable"]),
}).strict();
export type DocumentOutcome = z.infer<typeof documentOutcomeSchema>;
export class DocumentProcessError extends Error {
  constructor(readonly code: "aborted" | "unavailable" | "integrity" | "invalid_output") { super(code); this.name = "DocumentProcessError"; }
}
export type DocumentInput = {
  readonly format: "pdf" | "docx";
  readonly path: string;
  readonly directory: string;
};

export async function parseDocument(input: DocumentInput, signal: AbortSignal): Promise<DocumentOutcome> {
  signal.throwIfAborted();
  if (process.platform !== "linux") throw new DocumentProcessError("unavailable");
  return new Promise((resolve, reject) => {
    const child = spawn("/usr/bin/python3", ["-I", fileURLToPath(new URL("./shell-supervisor.py", import.meta.url)),
      String(process.pid), "/usr/bin/python3", "-I", fileURLToPath(new URL("./document-extract.py", import.meta.url)), input.format, input.path], {
      cwd: input.directory, stdio: ["ignore", "pipe", "pipe"],
      env: { PATH: "/usr/bin:/bin", LANG: "C.UTF-8", HOME: input.directory, TMPDIR: input.directory },
    });
    const chunks: Buffer[] = [];
    let bytes = 0, stderrBytes = 0, limited = false;
    const stop = (): void => { child.kill("SIGTERM"); };
    const timeout = setTimeout(() => { limited = true; stop(); }, 15000);
    signal.addEventListener("abort", stop, { once: true });
    if (signal.aborted) stop();
    child.stdout.on("data", (part: Buffer) => {
      bytes += part.length;
      if (bytes > 1250000) { limited = true; stop(); }
      else chunks.push(part);
    });
    child.stderr.on("data", (part: Buffer) => {
      stderrBytes += part.length;
      if (stderrBytes > 65536) { limited = true; stop(); }
    });
    child.on("error", () => reject(new DocumentProcessError("unavailable")));
    child.on("close", (code) => {
      clearTimeout(timeout);
      signal.removeEventListener("abort", stop);
      if (signal.aborted) { reject(new DocumentProcessError("aborted")); return; }
      if (limited || code === 137 || code === 152 || code === 153) {
        resolve({ kind: "complete", text: null, truncated: false, code: "resource_limit" }); return;
      }
      if (code !== 0) { reject(new DocumentProcessError("unavailable")); return; }
      try { resolve(documentOutcomeSchema.parse(JSON.parse(Buffer.concat(chunks).toString("utf8")))); }
      catch (error) {
        if (error instanceof SyntaxError || error instanceof z.ZodError) reject(new DocumentProcessError("invalid_output"));
        else reject(error);
      }
    });
  });
}

export type DocumentDownload = {
  readonly path: string;
  readonly bytes: number;
  readonly sha256: string;
};
export async function saveDocument(body: ReadableStream<Uint8Array>, expected: DocumentDownload, signal: AbortSignal): Promise<void> {
  if (expected.bytes < 0 || expected.bytes > 10 * 1024 * 1024) throw new DocumentProcessError("integrity");
  const file = await open(expected.path, "wx", 0o600);
  const reader = body.getReader(), hash = createHash("sha256");
  let bytes = 0;
  const cancel = (): void => { void reader.cancel().catch(error => { if (!(error instanceof Error)) throw error; }); };
  signal.addEventListener("abort", cancel, { once: true });
  try {
    for (;;) {
      signal.throwIfAborted();
      const next = await reader.read();
      if (next.done) break;
      bytes += next.value.byteLength;
      if (bytes > expected.bytes) throw new DocumentProcessError("integrity");
      hash.update(next.value);
      let offset = 0;
      while (offset < next.value.length) {
        const written = await file.write(next.value, offset, next.value.length - offset);
        offset += written.bytesWritten;
      }
    }
    signal.throwIfAborted();
    if (bytes !== expected.bytes || hash.digest("hex") !== expected.sha256) throw new DocumentProcessError("integrity");
  } finally {
    signal.removeEventListener("abort", cancel);
    try { await reader.cancel(); }
    finally {
      try { reader.releaseLock(); }
      finally { await file.close(); }
    }
  }
}
