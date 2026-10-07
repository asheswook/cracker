import { spawn } from "node:child_process";
import { writeFileSync } from "node:fs";
import { createInterface } from "node:readline";
import { z } from "zod";

const [mode, receipt, ...args] = process.argv.slice(2);
if (!mode || !receipt) throw new TypeError("fixture requires mode and receipt");
if (mode === "leaf") {
  process.on("SIGTERM", () => {});
  writeFileSync(receipt, String(process.pid));
  setInterval(() => {}, 1000);
} else if (mode === "branch") {
  spawn(process.execPath, [import.meta.filename, "leaf", `${receipt}.leaf`], { stdio: "inherit" });
  process.on("SIGTERM", () => {});
  writeFileSync(receipt, String(process.pid));
  setInterval(() => {}, 1000);
} else {
  spawn(process.execPath, [import.meta.filename, "branch", `${receipt}.branch`], { stdio: "inherit" });
  writeFileSync(receipt, JSON.stringify({ pid: process.pid, args, explicit: process.env["MCP_FIXTURE_EXPLICIT"], ambient: process.env["MCP_FIXTURE_AMBIENT"] }));
  process.on("SIGTERM", () => {});
  createInterface({ input: process.stdin }).on("line", line => {
    const request = z.object({ method: z.string(), id: z.union([z.string(), z.number()]).optional() }).parse(JSON.parse(line));
    if (request.id === undefined || mode === "stall") return;
    const result = request.method === "initialize"
      ? { protocolVersion: "2024-11-05", capabilities: { tools: {} }, serverInfo: { name: "process-fixture", version: "1" } }
      : request.method === "tools/list" ? { tools: [{ name: "echo", inputSchema: { type: "object", properties: {} } }] }
      : request.method === "tools/call" ? { content: [{ type: "text", text: "fixture-alive" }] } : {};
    process.stdout.write(`${JSON.stringify({ jsonrpc: "2.0", id: request.id, result })}\n`);
  });
  setInterval(() => {}, 1000);
}
