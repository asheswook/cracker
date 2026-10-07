import { chmod, mkdir } from "node:fs/promises";
import { dirname } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { z } from "zod";
import ky from "ky";
import { OpenAIProvider } from "../../packages/provider/index.ts";
import { preflightScreen } from "../../packages/screen/preflight.ts";
import { IceServer, ScreenError } from "../../packages/screen/protocol.ts";
import { controlErrorCode, controlErrorSummary } from "./control-diagnostic.ts";
import { Journal } from "./journal.ts";
import { Runtime, type RuntimeTiming, type ControlTiming } from "./runtime.ts";
import { startScreen } from "./screen.ts";
import { ToolExecutor } from "./tools.ts";
import { ModelResolver } from "./model-resolver.ts";
import { ModelAccountManager, accountOperations } from "./model-account.ts";

const BaseConfig = z.object({
  CONTROL_URL: z.url().refine((value) => {
    const url = new URL(value);
    return (
      url.protocol === "https:" ||
      (url.protocol === "http:" && ["127.0.0.1", "localhost"].includes(url.hostname))
    );
  }, "Remote control URL requires HTTPS"),
  VM_TOKEN: z.string().min(1),
  PROVIDER_MODE: z.enum(["api", "chatgpt"]),
  OPENAI_MODEL: z.string().min(1),
  OPENAI_TRANSPORT: z.enum(["http", "websocket"]).default("http"),
  OPENAI_REASONING_EFFORT: z.enum(["low","medium","high","xhigh","max"]).optional(),
  OPENAI_API_KEY: z.string().optional(),
  ANTHROPIC_API_KEY: z.string().optional(),
  CHATGPT_TOKEN_FILE: z.string().optional(),
  JOURNAL_PATH: z.string().default("./var/daemon.sqlite"),
  MCP_CONFIG: z.string().optional(),
  RUNTIME_TIMING: z.enum(["true","false"]).default("false"),
  TOOL_CONCURRENCY: z.coerce.number().int().min(1).max(8).default(3),
  AGENT_CONCURRENCY: z.coerce.number().int().min(1).max(8).default(3),
  SCREEN_ENABLED: z.enum(["true", "false"]).default("false"),
});
const ScreenEnvironment = z.object({
  VM_ID: z.uuid(),
  DISPLAY: z.string().regex(/^:\d+(?:\.\d+)?$/),
  SCREEN_ICE_SERVERS: z.string().default("[]"),
});
export function parseDaemonConfig(environment: Readonly<Record<string, string | undefined>>) {
  const base = BaseConfig.parse(environment);
  switch (base.PROVIDER_MODE) {
    case "api":
      z.string().trim().min(1).parse(base.OPENAI_API_KEY);
      break;
    case "chatgpt":
      z.string().trim().min(1).parse(base.CHATGPT_TOKEN_FILE);
      break;
    default:
      unreachable(base.PROVIDER_MODE);
  }
  if (base.SCREEN_ENABLED === "false") return { ...base, screen: undefined };
  const screen = ScreenEnvironment.parse(environment);
  return {
    ...base,
    screen: {
      vmId: screen.VM_ID,
      display: screen.DISPLAY,
      iceServers: z.array(IceServer).parse(JSON.parse(screen.SCREEN_ICE_SERVERS)),
    },
  };
}
export async function main(): Promise<void> {
  const config = parseDaemonConfig(process.env);
  if (config.screen) await preflightScreen(config.screen.display);
  if (process.argv.includes("--preflight")) {
    console.log(
      JSON.stringify({
        event: "daemon.preflight.ok",
        screen: config.screen !== undefined,
        provider_mode: config.PROVIDER_MODE,
        model: config.OPENAI_MODEL,
        reasoning_effort: config.OPENAI_REASONING_EFFORT ?? null,
      }),
    );
    return;
  }
  process.umask(0o077);
  const providerConfig = {
    mode: config.PROVIDER_MODE,
    model: config.OPENAI_MODEL,
    transport: config.OPENAI_TRANSPORT,
    serviceTier: "default" as const,
    ...(config.OPENAI_REASONING_EFFORT ? { reasoningEffort: config.OPENAI_REASONING_EFFORT } : {}),
    ...(config.OPENAI_API_KEY ? { apiKey: config.OPENAI_API_KEY } : {}),
    ...(config.CHATGPT_TOKEN_FILE ? { tokenFile: config.CHATGPT_TOKEN_FILE } : {}),
  };
  const provider = new OpenAIProvider(providerConfig);
  const models = new ModelResolver({ defaultProvider: provider, defaultConfig: providerConfig, http: ky.create({ prefixUrl: config.CONTROL_URL, headers: { authorization: `Bearer ${config.VM_TOKEN}` }, retry: 0, timeout: 15000 }), ...(config.ANTHROPIC_API_KEY ? { anthropicKey: config.ANTHROPIC_API_KEY } : {}) });
  await mkdir(dirname(config.JOURNAL_PATH), { recursive: true, mode: 0o700 });
  const journal = new Journal(config.JOURNAL_PATH);
  await chmod(config.JOURNAL_PATH, 0o600);
  const tools = new ToolExecutor();
  let screen: Awaited<ReturnType<typeof startScreen>> | undefined;
  const runtime = new Runtime({
    controlUrl: config.CONTROL_URL,
    token: config.VM_TOKEN,
    journal,
    provider,
    models,
    tools,
    toolConcurrency:config.TOOL_CONCURRENCY,
    agentConcurrency:config.AGENT_CONCURRENCY,
    inputBarrier:()=>tools.releaseDesktopInputs(),
    ...(config.RUNTIME_TIMING === "true" ? { onControlTiming:(event:ControlTiming)=>process.stdout.write(JSON.stringify({event:"runtime.control_timing",...event})+"\n"), onTiming: (event:RuntimeTiming)=>process.stdout.write(JSON.stringify({event:"runtime.timing",...event})+"\n") } : {}),
    releaseInput: async () => {
      await screen?.releaseInputs();
    },
  });
  const shutdown = new AbortController();
  const accountHttp = ky.create({ prefixUrl: config.CONTROL_URL, headers: { authorization: `Bearer ${config.VM_TOKEN}` }, retry: 0, timeout: 15000 });
  const account = config.CHATGPT_TOKEN_FILE ? new ModelAccountManager(accountHttp, accountOperations(config.CHATGPT_TOKEN_FILE, accountHttp), () => models.advertise()) : undefined;
  const requestShutdown = () => shutdown.abort();
  process.once("SIGTERM", requestShutdown);
  process.once("SIGINT", requestShutdown);
  try {
    if (config.screen) await tools.enableBuiltinBrowser();
    if (config.MCP_CONFIG) await tools.connect(config.MCP_CONFIG);
    let recovered = false,
      backoff = 1000;
    while (!shutdown.signal.aborted) {
      try {
        if (!recovered) {
          await models.advertise();
          await runtime.recover();
          if (config.screen)
            screen = await startScreen({
              controlUrl: config.CONTROL_URL,
              token: config.VM_TOKEN,
              vmId: config.screen.vmId,
              journal,
              iceServers: config.screen.iceServers,
            });
          recovered = true;
        }
        await account?.tick();
        await runtime.tick(!account?.busy);
        backoff = 1000;
      } catch (error) {
        if (!(error instanceof Error)) throw error;
        console.error(JSON.stringify(controlErrorSummary(error)));
        const diagnostic = controlErrorCode(error);
        await runtime.disconnect();
        const code = await diagnostic;
        if (code) console.error(JSON.stringify({ event: "daemon.control.response", code }));
        backoff = Math.min(backoff * 2, 30000);
      }
      try {
        await delay(backoff, undefined, { signal: shutdown.signal });
      } catch (error) {
        if (!(error instanceof Error && error.name === "AbortError")) throw error;
      }
    }
  } finally {
    await account?.close();
    process.removeListener("SIGTERM", requestShutdown);
    process.removeListener("SIGINT", requestShutdown);
    try {
      await runtime.stop();
    } finally {
      try {
        await screen?.();
      } finally {
        try {
          await provider.close();
        } finally {
          journal.close();
        }
      }
    }
  }
}
function unreachable(value: never): never {
  throw new ScreenError(`unsupported_provider:${String(value)}`);
}
if (import.meta.main) {
  try {
    await main();
  } catch (error) {
    if (!(error instanceof Error)) throw error;
    console.error(
      JSON.stringify({
        event: "daemon.failed",
        type: error.name,
        ...(error instanceof ScreenError ? { code: error.code } : {}),
      }),
    );
    process.exitCode = 1;
  }
}
