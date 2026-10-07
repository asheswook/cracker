import WebSocket from "ws";
import { z } from "zod";
import { captureScreen, inspectDisplay } from "../../packages/screen/capture";
import { screenFailure } from "../../packages/screen/diagnostic";
import { x11Executor } from "../../packages/screen/input";
import { ScreenPeer } from "../../packages/screen/peer";
import { daemonIceServers, fetchScreenIce, refreshDelay, rtcIceServers } from "../../packages/screen/ice";
import { type ControlOwner, IceServer, ScreenError, Signal } from "../../packages/screen/protocol";
import { ScreenSignaling } from "../../packages/screen/signaling";
import { pasteUnicode } from "../../packages/screen/text";
import { CaptureHub } from "../../packages/screen/capture-hub";
import { InputLease } from "../../packages/screen/input-lease";
import { MAX_SCREEN_VIEWERS } from "../../packages/screen/session-protocol";

export type ScreenConfig = {
  readonly controlUrl: string;
  readonly token: string;
  readonly vmId: string;
  readonly journal: ControlOwner;
  readonly iceServers: readonly z.infer<typeof IceServer>[];
};
export async function startScreen(config: ScreenConfig) {
  const vmId = z.uuid().parse(config.vmId);
  const display = z.string().parse(process.env["DISPLAY"]);
  const dimensions = await inspectDisplay(display);
  const iceServers = z
    .array(IceServer)
    .parse(config.iceServers)
    .map((server) => ({
      urls: server.urls,
      ...(server.username ? { username: server.username } : {}),
      ...(server.credential ? { credential: server.credential } : {}),
    }));
  const endpoint = new URL(`/v1/vms/${vmId}/screen`, config.controlUrl);
  if (
    endpoint.protocol !== "https:" &&
    !(endpoint.protocol === "http:" && ["127.0.0.1", "localhost"].includes(endpoint.hostname))
  )
    throw new ScreenError("secure_signaling_required");
  endpoint.protocol = endpoint.protocol === "https:" ? "wss:" : "ws:";
  endpoint.searchParams.set("screen_version", "2");
  let socket: WebSocket | undefined;
  const sessions = new Map<string, ScreenSignaling>();
  const lease = new InputLease(config.journal);
  const capture = new CaptureHub((track, failed) => captureScreen(track, { display, dimensions }, failed));
  let reconnect: ReturnType<typeof setTimeout> | undefined;
  let stopped = false;
  const refresh = new Map<string, ReturnType<typeof setTimeout>>();
  const leaseTimer = setInterval(() => { void lease.expire().catch(error => failure(error)); }, 1000);
  const failure = (error: unknown, frame?: Signal["type"]) => {
    console.error(
      JSON.stringify(
        screenFailure(
          error instanceof Error ? error : new ScreenError("unexpected_signal_failure"),
          {
            stage: frame === "ice" ? "ice_add" : "signal_apply",
            ...(frame ? { frame } : {}),
          },
        ),
      ),
    );
  };
  const connect = () => {
    if (stopped) return;
    const ws = new WebSocket(endpoint, { headers: { Authorization: `Bearer ${config.token}` } });
    socket = ws;
    const createSession = (viewerId: string) => new ScreenSignaling(
      async (current, signal, offer) => {
        clearTimeout(refresh.get(viewerId));
        let servers = iceServers;
        if (servers.length === 0) {
          const credentials = await fetchScreenIce(new URL(`/v1/daemon/vms/${vmId}/screen/ice`, config.controlUrl), { signal, token: config.token });
          if (!current() || stopped || ws !== socket) throw new ScreenError("ice_request_aborted");
          servers = rtcIceServers(daemonIceServers(credentials));
          const delay = refreshDelay(credentials);
          if (delay !== null) refresh.set(viewerId, setTimeout(() => {
            if (current() && !stopped && ws === socket) {
              ws.send(JSON.stringify({ type: "screen_error", code: "ice_credentials_refresh", viewer_id: viewerId }));
              void sessions.get(viewerId)?.close().catch(error => failure(error));
              sessions.delete(viewerId);
            }
          }, delay + 60000));
        }
        return new ScreenPeer({
          owner: config.journal,
          viewer: { id: viewerId, version: offer.version ?? 1, lease },
          visible: offer.version === 2 ? offer.visible ?? true : true,
          dimensions,
          iceServers: servers,
          execute: x11Executor(display),
          paste: (text, beforeInput) => pasteUnicode(text, display, beforeInput),
          capture: (track, onFailure) => capture.subscribe(track, onFailure),
          signal: (value) => {
            if (current() && !stopped && ws === socket && ws.readyState === WebSocket.OPEN)
              ws.send(JSON.stringify({ ...value, viewer_id: viewerId }));
          },
        });
      },
      (error, frame) => {
        failure(error, frame);
        if (!stopped && ws === socket && ws.readyState === WebSocket.OPEN)
          ws.send(JSON.stringify({ type: "screen_error", code: "screen_connection_failed", viewer_id: viewerId }));
      },
    );
    ws.onmessage = (event) => {
      if (stopped || ws !== socket) return;
      try {
        if (typeof event.data !== "string" || event.data.length > 140000)
          throw new ScreenError("invalid_signal");
        const signal = Signal.parse(JSON.parse(event.data));
        const viewerId = signal.viewer_id ?? "legacy";
        if (signal.type === "peer_left") {
          clearTimeout(refresh.get(viewerId));
          refresh.delete(viewerId);
          const previous = sessions.get(viewerId);
          sessions.delete(viewerId);
          void previous?.close().catch(error => failure(error, "peer_left"));
          return;
        }
        if (signal.type === "offer") {
          if (!sessions.has(viewerId)) {
            if (sessions.size >= MAX_SCREEN_VIEWERS) throw new ScreenError("viewer_limit_reached");
            sessions.set(viewerId, createSession(viewerId));
          }
        }
        sessions.get(viewerId)?.receive(signal);
      } catch (error: unknown) {
        failure(error);
      }
    };
    ws.onerror = () => {
      process.stderr.write("Screen signaling transport unavailable.\n");
      ws.close();
    };
    ws.onclose = () => {
      for (const timer of refresh.values()) clearTimeout(timer);
      refresh.clear();
      const closing = [...sessions.values()];
      sessions.clear();
      void Promise.all(closing.map(active => active.close()))
        .catch((error: unknown) => failure(error, "peer_left"))
        .finally(() => {
          if (!stopped && ws === socket) reconnect = setTimeout(connect, 2000);
        });
    };
  };
  connect();
  const stop = async () => {
    stopped = true;
    if (reconnect) clearTimeout(reconnect);
    clearInterval(leaseTimer);
    for (const timer of refresh.values()) clearTimeout(timer);
    refresh.clear();
    socket?.close();
    const closing = [...sessions.values()].map(active => active.close());
    sessions.clear();
    try { await Promise.all([lease.revoke(), ...closing]); }
    finally { await capture.close(); }
  };
  return Object.assign(stop, {
    releaseInputs: async () => {
      await lease.revoke();
      await Promise.all([...sessions.values()].map(active => active.releaseInputs()));
    },
  });
}
