import { expect, test } from "bun:test";
import { setTimeout as delay } from "node:timers/promises";
import ky from "ky";
import { SubscriptionAccountManager } from "../services/daemon/subscription-account.ts";
import { SubscriptionProxy } from "../services/daemon/subscription-proxy.ts";
import type { SubscriptionCommand } from "../packages/models/subscription-schema.ts";

test("subscription manager supports VM browser and local callback with state checks", async () => {
  const callbacks: string[] = [], opened: string[] = [];
  let changed = 0, state = 0;
  class Proxy extends SubscriptionProxy {
    override async startLogin() {
      state++;
      return { state: `state-${state}`, url: `https://claude.ai/oauth/authorize?state=state-${state}&redirect_uri=${encodeURIComponent('http://localhost:54545/callback')}` };
    }
    override async loginStatus() { return "ok" as const; }
    override async submitCallback(url: string) { callbacks.push(url); }
  }
  let command: SubscriptionCommand = { action: "login", provider: "claude", location: "local" };
  let observed = Promise.withResolvers<unknown>();
  const server = Bun.serve({ port: 0, async fetch(request) {
    if (new URL(request.url).pathname.endsWith("/claim")) return Response.json({ request: { request_id: crypto.randomUUID(), command } });
    observed.resolve(await request.json()); return Response.json({ accepted: true });
  } });
  const manager = new SubscriptionAccountManager(ky.create({ prefixUrl: server.url, retry: 0 }), new Proxy(), async () => { changed++; }, async url => { opened.push(url); });
  async function perform(next: SubscriptionCommand) {
    command = next; observed = Promise.withResolvers<unknown>();
    manager.tick();
    const result = await observed.promise;
    await delay(1550);
    return result;
  }
  try {
    expect(await perform(command)).toMatchObject({ result: { action: "login", state: "state-1" } });
    expect(opened).toEqual([]);
    expect(await perform({ action: "callback", state: "state-1", redirect_url: "http://localhost:54545/callback?state=wrong&code=one" })).toMatchObject({ result: null });
    expect(callbacks).toEqual([]);
    const url = "http://localhost:54545/callback?state=state-1&code=one";
    expect(await perform({ action: "callback", state: "state-1", redirect_url: url })).toMatchObject({ result: { accepted: true } });
    expect(callbacks).toEqual([url]);
    expect(await perform({ action: "status", state: "state-1" })).toMatchObject({ result: { status: "ok" } });
    expect(changed).toBe(1);
    expect(await perform({ action: "login", provider: "codex", location: "vm" })).toMatchObject({ result: { state: "state-2" } });
    expect(opened).toHaveLength(1);
  } finally { await manager.close(); await server.stop(true); }
}, 15000);

test("unsupported subscription control endpoint does not reject daemon tick", async () => {
  const server = Bun.serve({ port: 0, fetch: () => new Response("missing", { status: 404 }) });
  const manager = new SubscriptionAccountManager(ky.create({ prefixUrl: server.url, retry: 0 }), new SubscriptionProxy(), async () => {});
  try { manager.tick(); await manager.close(); }
  finally { await server.stop(true); }
});
