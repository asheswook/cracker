import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { browserServer } from "./browser-mcp";
import { DemonstrationRecorder } from "./demonstration.ts";

if (process.argv[2] === "--record-demonstration") {
  const recorder = new DemonstrationRecorder();
  const starting = recorder.start(process.argv[3] ?? "http://127.0.0.1:9222");
  let stopping = false;
  const stop = async () => {
    if (stopping) return;
    stopping = true;
    const steps = await recorder.stop();
    process.stdout.write(JSON.stringify({ steps }) + "\n", () => process.exit(0));
  };
  process.stdin.once("data", () => { void stop(); });
  process.stdin.once("end", () => { void stop(); });
  process.once("SIGTERM", () => { void stop(); });
  await starting;
  process.stdout.write(JSON.stringify({ ready: true }) + "\n");
} else {
  const bridge = await browserServer(process.argv[2]);
  await bridge.server.connect(new StdioServerTransport());
}
