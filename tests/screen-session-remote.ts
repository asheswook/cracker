import { once } from "node:events";
import { readFile } from "node:fs/promises";
import ky from "ky";
import WebSocket from "ws";
import { z } from "zod";

const Config = z.object({ control_url: z.url(), vm_id: z.uuid(), client_token: z.string() });
const config = Config.parse(JSON.parse(await readFile(".local/remote-connection.json", "utf8")));
const channel = z.enum(["screen", "notifications"]).parse(process.argv[2] ?? "screen");
const paths = { screen: `/v1/vms/${config.vm_id}/screen`, notifications: "/v1/connect" };
const http = ky.create({ prefixUrl: config.control_url, retry: 0, timeout: 15000 });
let socket: WebSocket | undefined;
try {
  // Given a browser session and its authenticated screen socket.
  const login = await http.post("v1/session", {
    headers: { Origin: config.control_url },
    json: { token: config.client_token },
  });
  const cookie = login.headers.get("set-cookie")?.split(";")[0];
  if (!cookie) throw new TypeError("Missing session cookie");
  const endpoint = new URL(paths[channel], config.control_url);
  endpoint.protocol = "wss:";
  socket = new WebSocket(endpoint, { headers: { Cookie: cookie, Origin: config.control_url } });
  socket.on("unexpected-response", (_request, response) => {
    response.resume();
    socket?.terminate();
  });
  await once(socket, "open", { signal: AbortSignal.timeout(15000) });
  const closed = once(socket, "close", { signal: AbortSignal.timeout(20000) });
  // When that session logs out while the parent client credential stays valid.
  await http.delete("v1/session", { headers: { Cookie: cookie, Origin: config.control_url } });
  socket.send("ping");
  // Then the existing screen connection is revoked, not merely subsequent HTTP requests.
  const [code] = await closed;
  if (code !== 1008) throw new TypeError("Screen session remained valid after logout");
  console.log(
    JSON.stringify({ event: "realtime.session_logout", channel, result: "pass", close_code: code }),
  );
} catch (error) {
  if (!(error instanceof Error)) throw error;
  console.error(
    JSON.stringify({
      event: "realtime.session_logout",
      channel,
      result: "failed",
      type: error.name,
    }),
  );
  process.exitCode = 1;
} finally {
  socket?.terminate();
}
