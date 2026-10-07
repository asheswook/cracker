import { DurableObject } from "cloudflare:workers";
import { z } from "zod";
import { Principal } from "./auth";
import { createDatabase } from "./db";

const Connection = Principal.extend({ credential_hash: z.string() });
type Environment = { readonly DATABASE: Hyperdrive };

export class AssistantRoom extends DurableObject<Environment> {
  async fetch(request: Request): Promise<Response> {
    if (request.headers.get("Upgrade")?.toLowerCase() !== "websocket")
      return new Response("WebSocket required", { status: 426 });
    const serialized = request.headers.get("X-Assistant-Principal");
    if (!serialized) return new Response("Unauthorized", { status: 401 });
    const connection = Connection.parse(JSON.parse(serialized));
    const pair = new WebSocketPair();
    const client = pair[0];
    const server = pair[1];
    server.serializeAttachment(connection);
    this.ctx.acceptWebSocket(server);
    await this.ctx.storage.setAlarm(Date.now() + 15000);
    server.send(JSON.stringify({ kind: "sync_required" }));
    return new Response(null, { status: 101, webSocket: client });
  }
  async notify(): Promise<void> {
    for (const socket of this.ctx.getWebSockets()) {
      if (!(await this.authorized(socket))) {
        socket.close(1008, "Session expired or credential revoked");
        continue;
      }
      if (socket.readyState === WebSocket.OPEN)
        socket.send(JSON.stringify({ kind: "sync_required" }));
    }
  }
  async webSocketMessage(socket: WebSocket, message: string | ArrayBuffer): Promise<void> {
    if (!(await this.authorized(socket))) {
      socket.close(1008, "Session expired or credential revoked");
      return;
    }
    if (message === "ping") socket.send("pong");
  }
  private async authorized(socket: WebSocket): Promise<boolean> {
    const parsed = Connection.safeParse(socket.deserializeAttachment());
    if (!parsed.success) return false;
    const peer = parsed.data;
    const sql = createDatabase(this.env.DATABASE.connectionString);
    try {
      const session = peer.session_hash ?? null;
      const rows =
        await sql`SELECT c.token_hash FROM assistant.credentials c WHERE c.token_hash=${peer.credential_hash} AND c.workspace_id=${peer.workspace_id} AND c.role=${peer.role} AND c.vm_id IS NOT DISTINCT FROM ${peer.vm_id}::uuid AND c.revoked_at IS NULL AND (${session}::text IS NULL OR EXISTS(SELECT 1 FROM assistant.browser_sessions s WHERE s.token_hash=${session} AND s.credential_hash=c.token_hash AND s.revoked_at IS NULL AND s.expires_at>now()))`;
      return rows.length === 1;
    } finally {
      await sql.end();
    }
  }
  async alarm(): Promise<void> {
    for (const socket of this.ctx.getWebSockets()) {
      if (!(await this.authorized(socket)))
        socket.close(1008, "Session expired or credential revoked");
    }
    if (this.ctx.getWebSockets().length) await this.ctx.storage.setAlarm(Date.now() + 15000);
  }
  async webSocketClose(socket: WebSocket, code: number): Promise<void> {
    socket.close(code);
  }
}
