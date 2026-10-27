import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { browserServer } from "./browser-mcp";
import { DemonstrationRecorder, type Recording } from "./demonstration.ts";
import { createInterface } from "node:readline";

if (process.argv[2] === "--record-demonstration") {
  const recorder = new DemonstrationRecorder();
  const starting = recorder.start(process.argv[3] ?? "http://127.0.0.1:9222");
  let stopping = false;
  let sent = false;
  const send = (result: Recording) => {
    if (sent) return;
    sent = true;
    process.stdout.write(JSON.stringify(result) + "\n", () => process.exit(0));
  };
  void recorder.finished.then(send); // The 300-step cap also disconnects and exits without waiting for stdin.
  const stop = async () => {
    if (stopping) return;
    stopping = true;
    send(await recorder.stop());
  };
  const input = createInterface({ input: process.stdin });
  input.on("line", line => {
    if (line.trim() === "snapshot" && !stopping) {
      void recorder.snapshot().then(result => {
        if (!sent && !stopping) process.stdout.write(JSON.stringify({ snapshot: true, ...result }) + "\n");
      });
    } else if (line.trim() === "stop") { void stop(); }
  });
  input.once("close", () => { void stop(); });
  process.once("SIGTERM", () => { void stop(); });
  await starting;
  process.stdout.write(JSON.stringify({ ready: true }) + "\n");
} else {
  const bridge = await browserServer(process.argv[2]);
  await bridge.server.connect(new StdioServerTransport());
}
