import Anthropic from "@anthropic-ai/sdk";
import { AnthropicProvider } from "../packages/provider/anthropic.ts";
import { Journal } from "../services/daemon/journal.ts";
import { nativeHash } from "../packages/provider/anthropic-context-frames.ts";
const [path, runId, url] = process.argv.slice(2);
if (!path || !runId || !url) throw new TypeError("fixture args");
class NoHydrationJournal extends Journal {
  override originalInput(): never {
    throw new TypeError("restart hydrated archive");
  }
}
const journal = new NoHydrationJournal(path);
const provider = new AnthropicProvider(
  { model: "claude-opus-5-5", apiKey: "fixture" },
  new Anthropic({ apiKey: "fixture", baseURL: url, maxRetries: 0 }),
);
try {
  const checkpoint = journal.recoverable(runId);
  if (!checkpoint?.nativeContext) throw new TypeError("checkpoint missing");
  const request = {
    runId,
    input: checkpoint.input,
    tools: [],
    state: checkpoint.nativeContext,
    signal: new AbortController().signal,
    clock: "resume-clock",
  };
  await provider.nativeContext.measure(request);
  const result = await provider.nativeContext.respond(request);
  console.log(
    JSON.stringify({
      activeBytes: Buffer.byteLength(JSON.stringify(checkpoint)),
      inputHash: nativeHash(checkpoint.input),
      archive: checkpoint.nativeContext.archive,
      responseId: result.response.id,
    }),
  );
} finally {
  provider.close();
  journal.close();
}
