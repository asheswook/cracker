import { test, expect } from "bun:test";
import { mkdtemp, stat, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { OpenAIProvider } from "../packages/provider/index.ts";
import { atomicSecret, readCredential } from "../packages/provider/credentials.ts";

test("ChatGPT mode cannot fall back to an API key", async () => {
  // Given
  const provider = new OpenAIProvider({ mode: "chatgpt", model: "configured-model", apiKey: "irrelevant" });
  // When / Then
  await expect(provider.respond([], [], new AbortController().signal)).rejects.toThrow("CHATGPT_TOKEN_FILE");
});
test("credential writer sets owner-only permissions and round trips identity", async () => {
  // Given
  const dir = await mkdtemp(join(tmpdir(), "assistant-secret-"));
  const path = join(dir, "credential.json");
  const credential = { issuer: "https://auth.openai.com" as const, subject: "subject", client_id: "issued", ext_agent_host_id: "host", id_token: "fixture", access_token: "fixture", refresh_token: "fixture", expires_at: Date.now() + 3600000, scopes: ["chatgpt.tokens.use.direct"] };
  // When
  await atomicSecret(path, credential);
  // Then
  try { expect((await stat(path)).mode & 0o777).toBe(0o600); expect(await readCredential(path)).toEqual(credential); }
  finally { await rm(dir, { recursive: true }); }
});
