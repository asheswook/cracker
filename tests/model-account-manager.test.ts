import { expect, test } from "bun:test";
import ky from "ky";
import { ModelAccountManager } from "../services/daemon/model-account.ts";
test("login does not block control polling, duplicate claims, or repeat after a lost report", async () => {
  const requestId = crypto.randomUUID(), done = Promise.withResolvers<void>();
  let claims = 0, connections = 0, observations = 0, advertise = 0;
  const server = Bun.serve({ port: 0, async fetch(request) {
    if (new URL(request.url).pathname.endsWith("claim")) { claims++; return Response.json({ request: { request_id: requestId, action: "connect" } }); }
    observations++;
    const body = await request.json();
    expect(body).toEqual({ request_id: requestId, state: "connected", error_code: null });
    return Response.json({}, { status: observations === 1 ? 503 : 200 });
  } });
  const manager = new ModelAccountManager(ky.create({ prefixUrl: server.url, retry: 0 }), {
    inspect: async () => ({ state: "disconnected", error_code: null }),
    connect: async () => { connections++; await done.promise; },
    disconnect: async () => ({ revoked: true }),
  }, async () => { advertise++; });
  try {
    await manager.tick(); expect(manager.busy).toBe(true);
    await manager.tick(); expect(claims).toBe(1); expect(connections).toBe(1);
    done.resolve(); await Bun.sleep(1);
    await expect(manager.tick()).rejects.toThrow(); expect(manager.busy).toBe(true);
    await manager.tick(); expect(manager.busy).toBe(false);
    expect(observations).toBe(2); expect(connections).toBe(1); expect(advertise).toBe(2);
  } finally { done.resolve(); await manager.close(); await server.stop(true); }
});
test("a cancelled local login report releases the daemon without repeating login", async () => {
  let connections = 0, observations = 0;
  const requestId = crypto.randomUUID();
  const server = Bun.serve({ port: 0, fetch(request) {
    if (new URL(request.url).pathname.endsWith("claim")) return Response.json({request:{request_id:requestId,action:"connect",login_location:"local",redirect_uri:"http://127.0.0.1:42111/auth/callback"}});
    observations++;
    return Response.json({error:{code:"stale_configuration"}},{status:409});
  } });
  const manager = new ModelAccountManager(ky.create({prefixUrl:server.url,retry:0}), {
    inspect:async()=>({state:"disconnected",error_code:null}),
    connect:async()=>{connections++; throw new Error("cancelled");},
    disconnect:async()=>({revoked:true}),
  },async()=>{});
  try {
    await manager.tick(); await Bun.sleep(1);
    expect(manager.busy).toBe(true);
    await manager.tick(); expect(manager.busy).toBe(false);
    await manager.tick(); expect(connections).toBe(1); expect(observations).toBe(1);
  } finally {await manager.close(); await server.stop(true);}
});
