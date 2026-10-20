import { expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import ky from "ky";
import { Message } from "../packages/protocol/index.ts";
import { TaskArtifacts, documentFamily } from "../services/daemon/artifacts.ts";

test("subscription Claude models use the Claude document family", () => {
  expect(documentFamily({ provider: "subscription", model: "claude-sonnet-5-5" })).toBe("claude");
  expect(documentFamily({ provider: "anthropic", model: "claude-opus-5-5" })).toBe("claude");
  expect(documentFamily({ provider: "subscription", model: "gpt-6-astra" })).toBe("gpt");
  expect(documentFamily({ provider: "chatgpt", model: "gpt-6-astra" })).toBe("gpt");
  expect(documentFamily(undefined)).toBe("gpt");
});

async function attach(name: string, media: string, bytes: Uint8Array, family: "gpt" | "claude") {
  const root = await mkdtemp(join(tmpdir(), "claude-text-"));
  const body = Buffer.from(bytes);
  const server = Bun.serve({ hostname: "127.0.0.1", port: 0, fetch: () => new Response(body) });
  try {
    const conversationId = crypto.randomUUID();
    const artifacts = await TaskArtifacts.create({ http: ky.create({ prefixUrl: server.url.href, retry: 0 }), runId: crypto.randomUUID(), conversationId, root, documentFamily: family });
    const message = Message.parse({
      id: crypto.randomUUID(), conversation_id: conversationId, role: "user", content: "read it", sequence: 1,
      created_at: new Date().toISOString(), client_message_id: null,
      attachments: [{ id: crypto.randomUUID(), name, media_type: media, bytes: bytes.byteLength, sha256: new Bun.CryptoHasher("sha256").update(bytes).digest("hex"), state: "ready", created_at: new Date().toISOString() }],
    });
    const item = (await artifacts.input(message, AbortSignal.timeout(5000))).at(-1);
    if (!item || !("content" in item) || typeof item.content === "string") throw new Error("missing attachment content");
    return item.content;
  } finally {
    server.stop(true);
    await rm(root, { recursive: true, force: true });
  }
}

test("Claude receives a pasted text attachment in full as text, never as a file block", async () => {
  // Given a long pasted transcript like the one that failed with HTTP 400.
  const transcript = Array.from({ length: 400 }, (_, i) => `대표: 질문 ${i}\nCOO: 답변 ${i}`).join("\n");
  // When it is prepared for a Claude model.
  const content = await attach("pasted-text.txt", "text/plain", new TextEncoder().encode(transcript), "claude");
  // Then the whole text is inline and no input_file reaches the proxy.
  expect(content.some(part => part.type === "input_file")).toBe(false);
  const inline = content.find(part => part.type === "input_text" && part.text.startsWith("<attachment"));
  expect(inline && "text" in inline ? inline.text : "").toContain(transcript);
  expect(content.some(part => part.type === "input_text" && part.text.includes('"inspection"'))).toBe(false);
});

test("GPT keeps text attachments as file blocks", async () => {
  const content = await attach("notes.md", "text/markdown", new TextEncoder().encode("# 메모"), "gpt");
  expect(content.some(part => part.type === "input_file")).toBe(true);
});

test("Claude falls back to the local file for non-UTF-8 text", async () => {
  const content = await attach("legacy.txt", "text/plain", new Uint8Array([0xff, 0xfe, 0x00, 0xd8]), "claude");
  expect(content.some(part => part.type === "input_file")).toBe(false);
  expect(content.some(part => part.type === "input_text" && part.text.includes('"inspection"'))).toBe(true);
});
