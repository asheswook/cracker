import { afterAll, beforeAll, expect, test } from "bun:test";
import { execFile } from "node:child_process";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import { documentOutcomeSchema } from "../services/daemon/document-parser.ts";

const samples = "tests/fixtures/documents";
const run = promisify(execFile);
const generated = await mkdtemp(join(tmpdir(), "document-large-"));
beforeAll(async () => {
  await run("python3", ["-I", "tests/fixtures/document-large-fixtures.py", generated]);
});
afterAll(async () => {
  await rm(generated, { recursive: true, force: true });
});
async function extract(name: string) {
  const directory = /^(large-binary|near-limit|oversized|long-text\.pdf|many-pages-text)/.test(name)
    ? generated
    : samples;
  const result = await run(
    "python3",
    [
      "-I",
      "services/daemon/document-extract.py",
      name.endsWith("pdf") ? "pdf" : "docx",
      join(directory, name),
    ],
    { maxBuffer: 1250000 },
  );
  return documentOutcomeSchema.parse(JSON.parse(result.stdout));
}

test("extracts actual compressed Unicode PDF and split-run DOCX", async () => {
  const pdf = await extract("ordinary.pdf"),
    docx = await extract("ordinary.docx");
  expect(pdf.text).toContain("BODYONLYPDFTOKEN café Ελληνικά 한글 문서");
  expect(docx.text).toBe("BODYONLYDOCXTOKEN café 한글 & Ω\nSecond paragraph\nA\tB\nC");
  expect(pdf.truncated || docx.truncated).toBe(false);
});

test("reads complete binaries above text prefix limit and close to upload limit", async () => {
  for (const name of [
    "large-binary.pdf",
    "near-limit.pdf",
    "large-binary.docx",
    "near-limit.docx",
  ]) {
    const result = await extract(name);
    expect(result.code).toBe("text");
    expect(result.text).toContain(
      name === "near-limit.docx"
        ? "NEARLIMITDOCXTOKEN"
        : name.endsWith("pdf")
          ? "BODYONLYPDFTOKEN"
          : "LARGEDOCXBODYTOKEN",
    );
  }
});

test("retains a truthful bounded prefix of long documents", async () => {
  for (const name of ["long-text.pdf", "long-text.docx"]) {
    const result = await extract(name);
    expect(result.code).toBe("text");
    expect(result.truncated).toBe(true);
    expect(result.text?.length).toBeLessThanOrEqual(200000);
  }
  const emptyPrefix = await extract("many-pages.pdf");
  expect(emptyPrefix.text).toBeNull();
  expect(emptyPrefix.truncated).toBe(true);
  const prefix = await extract("many-pages-text.pdf");
  expect(prefix.text).toContain("PREFIXTOKEN");
  expect(prefix.text).not.toContain("AFTERLIMITTOKEN");
  expect(prefix.truncated).toBe(true);
});

test("returns terminal null outcomes for encrypted malformed empty and bounded attacks", async () => {
  const cases = [
    ["encrypted.pdf", "encrypted_or_malformed"],
    ["malformed.pdf", "encrypted_or_malformed"],
    ["no-text.pdf", "empty"],
    ["no-text.docx", "empty"],
    ["malformed.docx", "malformed"],
    ["xml-bomb.docx", "resource_limit"],
    ["entry-bomb.docx", "resource_limit"],
    ["expanded-bomb.docx", "resource_limit"],
    ["doctype.docx", "unsupported"],
    ["dishonest-size.docx", "resource_limit"],
    ["oversized.docx", "input_limit"],
  ] as const;
  for (const [name, code] of cases) {
    const result = await extract(name);
    expect(result.text).toBeNull();
    expect(result.code).toBe(code);
  }
});

test("rejects a filename masquerading as PDF without trusting its extension", async () => {
  const directory = await mkdtemp(join(tmpdir(), "document-signature-"));
  try {
    const path = join(directory, "fake.pdf");
    await Bun.write(path, "not a PDF");
    const child = await run("python3", ["-I", "services/daemon/document-extract.py", "pdf", path]);
    const result = documentOutcomeSchema.parse(JSON.parse(child.stdout));
    expect(result.code).toBe("signature_mismatch");
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});
