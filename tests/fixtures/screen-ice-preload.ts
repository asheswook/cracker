import { mock } from "bun:test";

mock.module("cloudflare:workers", () => ({ DurableObject: class {} }));
const provider = Bun.serve({ port: 0, hostname: "127.0.0.1", fetch: () => Response.json({
  iceServers: [{ urls: ["turns:relay.example:443?transport=tcp"], username: "test-user", credential: "test-only-credential" }],
}) });
const nativeFetch = globalThis.fetch;
globalThis.fetch = Object.assign((input: Parameters<typeof fetch>[0], init?: Parameters<typeof fetch>[1]) => {
  const request = new Request(input, init);
  const url = new URL(request.url);
  if (url.hostname === "rtc.live.cloudflare.com")
    return nativeFetch(new Request(new URL(url.pathname, provider.url), request));
  if (!["127.0.0.1", "localhost"].includes(url.hostname))
    throw new TypeError("External HTTP is forbidden in the screen entrypoint fixture");
  return nativeFetch(request);
}, nativeFetch);
