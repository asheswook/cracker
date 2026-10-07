import Anthropic from "@anthropic-ai/sdk";
import { AnthropicProvider } from "../packages/provider/anthropic.ts";
import { Journal } from "../services/daemon/journal.ts";
import { Runtime } from "../services/daemon/runtime.ts";
import { ToolExecutor } from "../services/daemon/tools.ts";

const [path, artifactRoot, controlUrl, providerUrl, runId] = process.argv.slice(2);
if (!path || !artifactRoot || !controlUrl || !providerUrl || !runId)
  throw new TypeError("fixture args");
class ResumeJournal extends Journal {
  override originalInput():never{throw new TypeError("runtime hydrated retired native history");}
  readonly done = Promise.withResolvers<void>();
  override finish(run: string): void {
    super.finish(run);
    this.done.resolve();
  }
}
const journal = new ResumeJournal(path),
  failures: string[] = [];
const provider = new AnthropicProvider(
  { model: "claude-opus-5-5", apiKey: "fixture" },
  new Anthropic({ apiKey: "fixture", baseURL: providerUrl, maxRetries: 0 }),
);
const runtime = new Runtime({
  journal,
  provider,
  tools: new ToolExecutor(),
  artifactRoot,
  controlUrl,
  token: "fixture",
  onFailure: (event) => failures.push(event.code),
});
try {
  await runtime.recover();
  await journal.done.promise;
  await runtime.flush();
  console.log(JSON.stringify({ failures, checkpoint: journal.recoverable(runId) }));
} finally {
  await runtime.stop();
  provider.close();
  journal.close();
}
