import ky from "ky";
import { z } from "zod";
import { IceServer, ScreenError } from "./protocol";

export const IceConfiguration = z.discriminatedUnion("mode", [
  z.object({ mode: z.literal("direct"), iceServers: z.tuple([]), expiresAt: z.null() }),
  z.object({ mode: z.literal("turn"), iceServers: z.array(IceServer).min(1).max(32), expiresAt: z.number().int().positive() }),
]);
export type IceConfiguration = z.infer<typeof IceConfiguration>;
export function rtcIceServers(servers: readonly z.infer<typeof IceServer>[]) {
  return servers.map((server) => ({
    urls: server.urls,
    ...(server.username ? { username: server.username } : {}),
    ...(server.credential ? { credential: server.credential } : {}),
  }));
}

export async function fetchScreenIce(url: URL, options: { readonly signal: AbortSignal; readonly token?: string;readonly sessionId?:string }): Promise<IceConfiguration> {
  try {
    const body = await ky.post(url, {
      signal: options.signal,
      cache: "no-store",
      timeout: 10000,
      retry: 0,
      headers:{...(options.token ? { Authorization: `Bearer ${options.token}` } : {}),...(options.sessionId?{'x-daemon-session':options.sessionId}:{})},
    }).json();
    const config = IceConfiguration.parse(body);
    refreshDelay(config);
    return config;
  } catch (error) {
    if (!(error instanceof Error)) throw error;
    if (options.signal.aborted) throw new ScreenError("ice_request_aborted");
    throw new ScreenError("ice_credentials_unavailable");
  }
}

export function refreshDelay(config: IceConfiguration, now = Date.now()): number | null {
  if (config.mode === "direct") return null;
  const delay = config.expiresAt - now - 120000;
  if (delay <= 0) throw new ScreenError("ice_credentials_expiring");
  return delay;
}

// werift 0.24.4 consumes one TURN URL only; explicitly choose TLS on 443.
export function daemonIceServers(config: IceConfiguration): z.infer<typeof IceServer>[] {
  if (config.mode === "direct") return [];
  const relay = config.iceServers.find((server) => /^turns:[^?]+:443(?:\?transport=tcp)?$/.test(server.urls));
  if (!relay) throw new ScreenError("ice_tls_transport_unavailable");
  const stun = config.iceServers.find((server) => server.urls.startsWith("stun:"));
  return stun ? [stun, relay] : [relay];
}
