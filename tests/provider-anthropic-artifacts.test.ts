import { expect, test } from "bun:test";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import ky from "ky";
import { z } from "zod";
import { Message } from "../packages/protocol/index.ts";
import { anthropicTranscript } from "../packages/provider/anthropic-messages.ts";
import type { ResponseInputItem } from "../packages/provider/index.ts";
import { TaskArtifacts } from "../services/daemon/artifacts.ts";

test.each([
  {
    name: "source.pdf",
    media: "application/pdf",
    bytes: "%PDF-1.4\ntransport fixture",
    source: "base64",
  },
  { name: "source.txt", media: "text/plain", bytes: "한국어 원문\nSecond line", source: "text" },
  { name: "source.csv", media: "text/csv", bytes: "항목,수량\n자료,3", source: "text" },
  {
    name: "source.md",
    media: "application/octet-stream",
    bytes: "# 한국어\n첨부 내용",
    source: "text",
  },
  {
    name: "source.docx",
    media: "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
    bytes: "office transport bytes",
    source: "local",
  },
])(
  "TaskArtifacts downloads and integrity-checks $name into Claude document content",
  async (fixture) => {
    // Given
    const bytes = Buffer.from(fixture.bytes),
      attachmentId = crypto.randomUUID(),
      conversationId = crypto.randomUUID();
    const root = await mkdtemp(join(tmpdir(), "claude-artifact-"));
    const server = Bun.serve({
      hostname: "127.0.0.1",
      port: 0,
      fetch() {
        return new Response(bytes);
      },
    });
    const artifacts = await TaskArtifacts.create({
      http: ky.create({ prefixUrl: server.url.href, retry: 0 }),
      runId: crypto.randomUUID(),
      conversationId,
      root,
      documentFamily: "claude",
    });
    const input = Message.parse({
      id: crypto.randomUUID(),
      conversation_id: conversationId,
      role: "user",
      content: "Read attachment",
      sequence: 1,
      created_at: new Date().toISOString(),
      client_message_id: null,
      attachments: [
        {
          id: attachmentId,
          name: fixture.name,
          media_type: fixture.media,
          bytes: bytes.byteLength,
          sha256: new Bun.CryptoHasher("sha256").update(bytes).digest("hex"),
          state: "ready",
          created_at: new Date().toISOString(),
        },
      ],
    });
    try {
      // When
      const canonical = await artifacts.input(input, AbortSignal.timeout(5000));
      const request = anthropicTranscript(canonical, "claude-opus-5-5");
      // Then
      const parts = request.messages.flatMap((turn) =>
        typeof turn.content === "string" ? [] : turn.content,
      );
      const document = parts.find((part) => part.type === "document");
      if (fixture.source === "local") expect(document).toBeUndefined();
      else
        expect(document).toMatchObject({
          type: "document",
          title: fixture.name,
          source: {
            type: fixture.source,
            data: fixture.source === "text" ? fixture.bytes : bytes.toString("base64"),
          },
        });
      expect(
        parts.some(
          (part) =>
            part.type === "text" &&
            part.text.includes('"local_path":') &&
            part.text.includes('"untrusted_attachment"'),
        ),
      ).toBe(true);
      const localPath = join(
        artifacts.directory,
        "inputs",
        attachmentId + fixture.name.slice(fixture.name.lastIndexOf(".")),
      );
      expect(await readFile(localPath)).toEqual(bytes);
    } finally {
      server.stop(true);
      await rm(root, { recursive: true, force: true });
    }
  },
);

test.each([
  {
    family: "claude" as const,
    batches: [[10485760, 10485760, 10485760]],
    inline: [2],
    resume: false,
  },
  { family: "gpt" as const, batches: [[10485760, 10485760, 10485760]], inline: [3], resume: false },
  {
    family: "claude" as const,
    batches: [[10485760, 10485759], [2], [1], [1]],
    inline: [2, 0, 1, 0],
    resume: true,
  },
])(
  "$family keeps all local PDFs with bounded inline content (resume=$resume)",
  async (scenario) => {
    // Given distinct synthetic PDF transport files served over real loopback HTTP.
    const root = await mkdtemp(join(tmpdir(), "attachment-budget-"));
    const files = scenario.batches.map((batch) =>
      batch.map((size, index) => {
        const id = crypto.randomUUID(),
          bytes = Buffer.alloc(size, 65 + index);
        return { id, bytes, sha256: new Bun.CryptoHasher("sha256").update(bytes).digest("hex") };
      }),
    );
    const byId = new Map<string, Uint8Array<ArrayBuffer>>(
      files.flat().map((file) => [file.id, file.bytes]),
    );
    const server = Bun.serve({
      hostname: "127.0.0.1",
      port: 0,
      fetch(request) {
        const id = new URL(request.url).pathname.split("/").at(-2);
        const bytes = id ? byId.get(id) : undefined;
        return bytes ? new Response(bytes) : new Response(null, { status: 404 });
      },
    });
    const scope = {
      http: ky.create({ prefixUrl: server.url.href, retry: 0 }),
      runId: crypto.randomUUID(),
      conversationId: crypto.randomUUID(),
      root,
      documentFamily: scenario.family,
    };
    try {
      let artifacts = await TaskArtifacts.create(scope);
      const all: ResponseInputItem[] = [],
        counts: number[] = [];
      for (const [index, batch] of files.entries()) {
        const message = Message.parse({
          id: crypto.randomUUID(),
          conversation_id: scope.conversationId,
          role: "user",
          content: "",
          client_message_id: null,
          sequence: index + 1,
          created_at: new Date().toISOString(),
          attachments: batch.map((file) => ({
            id: file.id,
            name: `${file.id}.pdf`,
            media_type: "application/pdf",
            bytes: file.bytes.length,
            sha256: file.sha256,
            state: "ready",
            created_at: new Date().toISOString(),
          })),
        });
        // When admissions cross the budget, including after a real checkpoint/resume.
        const canonical = await artifacts.input(message, AbortSignal.timeout(10000));
        all.push(...canonical);
        const parts = z
          .array(
            z.union([
              z.object({ type: z.literal("input_text"), text: z.string() }),
              z.object({ type: z.literal("input_file"), filename: z.string() }),
            ]),
          )
          .parse(
            canonical.flatMap<unknown>((item) =>
              "content" in item && Array.isArray(item.content) ? item.content : [],
            ),
          );
        const inline = parts.filter((part) => part.type === "input_file");
        counts.push(inline.length);
        // Then every file remains addressable with original bytes, including omitted inline files.
        expect(inline).toHaveLength(scenario.inline[index] ?? -1);
        const manifests = parts.flatMap((part) =>
          part.type === "input_text"
            ? [
                z
                  .object({
                    kind: z.literal("untrusted_attachment"),
                    id: z.uuid(),
                    local_path: z.string(),
                    inspection: z.string().optional(),
                  })
                  .parse(JSON.parse(part.text)),
              ]
            : [],
        );
        expect(manifests).toHaveLength(batch.length);
        for (const file of batch) {
          const manifest = manifests.find((item) => item.id === file.id);
          if (!manifest) throw new TypeError("Missing attachment manifest");
          expect(
            new Bun.CryptoHasher("sha256")
              .update(await readFile(manifest.local_path))
              .digest("hex"),
          ).toBe(file.sha256);
          if (
            !inline.some((part) => part.type === "input_file" && part.filename === `${file.id}.pdf`)
          )
            expect(manifest.inspection).toBeDefined();
        }
        if (scenario.resume) {
          artifacts = await TaskArtifacts.resume(scope, artifacts.checkpoint());
          expect(await artifacts.input(message, AbortSignal.timeout(10000))).toEqual([]);
        }
      }
      const bodyBytes =
        scenario.family === "claude"
          ? Buffer.byteLength(JSON.stringify(anthropicTranscript(all, "claude-opus-5-5")))
          : null;
      if (bodyBytes !== null) expect(bodyBytes).toBeLessThan(32000000);
      const expectedRaw = scenario.family === "claude" ? 20971520 : 31457280;
      expect(artifacts.checkpoint().inlineBytes).toBe(expectedRaw);
      console.log(
        JSON.stringify({
          event: "artifact.inline_budget.verified",
          family: scenario.family,
          resume: scenario.resume,
          inline_counts: counts,
          manifests: files.flat().length,
          body_bytes: bodyBytes,
          file_sha256: files.flat().map((file) => file.sha256),
        }),
      );
    } finally {
      await server.stop(true);
      await rm(root, { recursive: true, force: true });
    }
  },
);
