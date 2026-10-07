import { expect, test } from "bun:test";
import ky from "ky";
import { daemonIceServers, fetchScreenIce, refreshDelay, rtcIceServers } from "../packages/screen/ice";
import { ScreenPeer } from "../packages/screen/peer";
import { generateScreenIce, screenTurnConfig } from "../services/control/screen-ice";

const config = { SCREEN_TURN_KEY_ID: "test-key", SCREEN_TURN_API_TOKEN: "test-only-provider-token" };
const servers = [
  { urls: "stun:relay.example:3478" },
  { urls: "turn:relay.example:3478?transport=udp", username: "test-user", credential: "test-only-secret" },
  { urls: "turns:relay.example:443?transport=tcp", username: "test-user", credential: "test-only-secret" },
];

test("provider response arrays normalize and request credentials for one hour", async () => {
  // Given a local HTTP stand-in for the provider, with its real JSON contract.
  let observed: unknown;
  const server = Bun.serve({ port: 0, fetch: async (request) => {
    observed = { method: request.method, path: new URL(request.url).pathname, body: await request.json(), authorized: request.headers.get("Authorization") === `Bearer ${config.SCREEN_TURN_API_TOKEN}` };
    return Response.json({ iceServers: [{ urls: [servers[0]?.urls] }, { urls: servers.slice(1).map((server) => server.urls), username: "test-user", credential: "test-only-secret" }] });
  } });
  const http = ky.create({ fetch: (input, options) => {
    const request = new Request(input, options);
    return fetch(new Request(new URL(new URL(request.url).pathname, server.url), request));
  } });
  try {
    // When the production adapter issues a credential request.
    const before = Date.now();
    const result = await generateScreenIce(config, new AbortController().signal, http);
    // Then URL, authentication, TTL, normalization and usable lifetime match the contract.
    expect(observed).toEqual({ method: "POST", path: "/v1/turn/keys/test-key/credentials/generate-ice-servers", body: { ttl: 3600 }, authorized: true });
    expect(result.iceServers).toEqual(servers);
    expect(result.expiresAt).toBeGreaterThanOrEqual(before + 3600000);
  } finally { await server.stop(true); }
});

test.each([403, 500])("provider HTTP %s fails without direct fallback or leaking provider details", async (status) => {
  // Given a provider failure containing sensitive-looking fixture text.
  const http = ky.create({ fetch: async () => new Response("test-only-secret", { status }) });
  // When credentials are requested.
  const error = await generateScreenIce(config, new AbortController().signal, http).catch((error: unknown) => error);
  // Then only the stable public failure escapes.
  expect(error).toBeInstanceOf(Error);
  expect(error instanceof Error && error.message).toBe("TURN credentials unavailable");
});

test("partial configuration fails while absent configuration remains direct", () => {
  // Given absent versus incomplete opt-in configuration.
  // When parsed.
  const absent = screenTurnConfig({});
  // Then incomplete opt-in is never treated as disabled.
  expect(absent).toBeUndefined();
  expect(() => screenTurnConfig({ SCREEN_TURN_KEY_ID: "test-key" })).toThrow("TURN configuration is incomplete");
});

test("daemon selects TLS 443 despite an earlier UDP TURN URL", () => {
  // Given the URL order emitted by a multi-transport provider.
  // When choosing the single werift TURN transport.
  const selected = daemonIceServers({ mode: "turn", iceServers: servers, expiresAt: 3600000 });
  // Then the unsupported assumption of URL fallback is unnecessary.
  expect(selected.map((server) => server.urls)).toEqual(["stun:relay.example:3478", "turns:relay.example:443?transport=tcp"]);
});

test("daemon refuses generated credentials without its selected TLS transport", () => {
  // Given a provider response lacking the required transport.
  // When selecting daemon ICE servers.
  // Then it fails explicitly rather than pretending the other URLs are fallback.
  expect(() => daemonIceServers({ mode: "turn", iceServers: servers.slice(0, 2), expiresAt: 3600000 })).toThrow("ice_tls_transport_unavailable");
});

test("refresh is due two minutes before expiry and rejects stale credentials", () => {
  // Given a known credential lease and deterministic current time.
  const lease = { mode: "turn", iceServers: servers, expiresAt: 3600000 } as const;
  // When the refresh delay is computed.
  const delay = refreshDelay({ ...lease, iceServers: [...servers] }, 1000000);
  // Then the application replaces the connection before provider expiry.
  expect(delay).toBe(2480000);
  expect(() => refreshDelay({ ...lease, iceServers: [...servers] }, 3480000)).toThrow("ice_credentials_expiring");
});

test("credential fetch sends POST and rejects explicit server failure", async () => {
  // Given a local credential endpoint returning an unavailable response.
  let method = "";
  const server = Bun.serve({ port: 0, fetch: (request) => { method = request.method; return Response.json({ error: { code: "turn_credentials_unavailable" } }, { status: 503 }); } });
  try {
    // When a peer fetches its configuration.
    const error = await fetchScreenIce(server.url, { signal: new AbortController().signal }).catch((error: unknown) => error);
    // Then it cannot silently create a direct-only peer.
    expect(method).toBe("POST");
    expect(error instanceof Error && error.message).toBe("ice_credentials_unavailable");
  } finally { await server.stop(true); }
});

test("installed werift actually configures TLS 443 for the selected generated server", async () => {
  // Given the production peer with a normalized generated server list.
  const peer = new ScreenPeer({ owner: { control: () => "agent" }, dimensions: { width: 160, height: 120 },
    iceServers: rtcIceServers(daemonIceServers({ mode: "turn", iceServers: servers, expiresAt: 3600000 })),
    execute: async () => {}, signal: () => {}, capture: async () => async () => {},
  });
  try {
    // When installed werift creates its ICE transport without network gathering.
    const options = peer.pc.iceTransports[0]?.connection.options;
    // Then its actual parsed transport is TLS at the selected host and port.
    expect(options?.turnServer).toEqual(["relay.example", 443]);
    expect(options?.turnTransport).toBe("tls");
  } finally { await peer.close(); }
});

test("provider credentials missing on selected TLS server are rejected", async () => {
  // Given malformed provider output with a credential-less TLS entry.
  const http = ky.create({ fetch: async () => Response.json({ iceServers: [{ urls: "turns:relay.example:443" }] }) });
  // When production parses the provider response.
  const error = await generateScreenIce(config, new AbortController().signal, http).catch((error: unknown) => error);
  // Then it never emits unusable success credentials.
  expect(error instanceof Error && error.message).toBe("TURN credentials unavailable");
});
