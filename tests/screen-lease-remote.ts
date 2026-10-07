import { once } from "node:events";
import { readFile } from "node:fs/promises";
import { setTimeout as delay } from "node:timers/promises";
import WebSocket from "ws";
import { z } from "zod";

const config = z
  .object({ control_url: z.url(), vm_id: z.uuid(), client_token: z.string() })
  .parse(JSON.parse(await readFile(".local/remote-connection.json", "utf8")));
const endpoint = new URL(`/v1/vms/${config.vm_id}/screen`, config.control_url);
endpoint.protocol = "wss:";
let socket: WebSocket | undefined;
let timer: ReturnType<typeof setInterval> | undefined;

async function connect(): Promise<WebSocket> {
  const peer = new WebSocket(endpoint, {
    headers: { Authorization: `Bearer ${config.client_token}` },
  });
  socket = peer;
  peer.on("unexpected-response", (_request, response) => {
    response.resume();
    peer.terminate();
  });
  await once(peer, "open", { signal: AbortSignal.timeout(15000) });
  return peer;
}

try {
  const idle = await connect();
  const start = Date.now();
  const [code, reason] = await once(idle, "close", { signal: AbortSignal.timeout(80000) });
  const elapsed = Date.now() - start;
  console.log(
    JSON.stringify({ test: "idle_observed", code, reason: String(reason), elapsed_ms: elapsed }),
  );
  if (code !== 1001 || String(reason) !== "Viewer heartbeat expired" || elapsed < 44000)
    throw new Error("idle_lease_not_enforced");
  console.log(JSON.stringify({ test: "idle_expiry", code, elapsed_ms: elapsed }));

  const alive = await connect();
  let pongs = 0;
  alive.on("message", (value) => {
    if (String(value) === "pong") pongs++;
  });
  timer = setInterval(() => {
    if (alive.readyState === WebSocket.OPEN) alive.send("ping");
  }, 10000);
  await delay(60000);
  if (alive.readyState !== WebSocket.OPEN || pongs < 5) throw new Error("heartbeat_lease_lost");
  console.log(JSON.stringify({ test: "heartbeat_survives", elapsed_ms: 60000, pongs }));
  clearInterval(timer);
  timer = undefined;
  const closed = once(alive, "close", { signal: AbortSignal.timeout(15000) });
  const closing = Date.now();
  alive.close(1000, "viewer_closed");
  const [closeCode] = await closed;
  if (closeCode !== 1000) throw new Error("normal_close_failed");
  console.log(
    JSON.stringify({ test: "normal_close", code: closeCode, elapsed_ms: Date.now() - closing }),
  );
} catch (error) {
  console.error(
    JSON.stringify({
      test: "screen_lease",
      result: "failed",
      type: error instanceof Error ? error.name : "unknown",
      code:
        error instanceof Error &&
        ["idle_lease_not_enforced", "heartbeat_lease_lost", "normal_close_failed"].includes(
          error.message,
        )
          ? error.message
          : "transport_or_deadline",
    }),
  );
  process.exitCode = 1;
} finally {
  if (timer) clearInterval(timer);
  socket?.terminate();
}
