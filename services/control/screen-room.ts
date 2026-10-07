import { DurableObject } from "cloudflare:workers";
import { z } from "zod";
import { createDatabase } from "./db";
import { MAX_SCREEN_VIEWERS } from "../../packages/screen/session-protocol";

const Attachment = z.object({
  role: z.enum(["client", "vm"]),
  token_hash: z.string(),
  session_hash: z.string().nullable().default(null),
  vm_id: z.uuid(),
  workspace_id: z.uuid(),
  last_activity: z.number().default(0),
  closing: z.boolean().default(false),
  viewer_id: z.uuid().optional(),
  version: z.union([z.literal(1), z.literal(2)]).default(1),
});
const Frame = z.discriminatedUnion("type", [
  z.object({ type: z.literal("offer"), sdp: z.string().max(100000), visible: z.boolean().optional(), viewer_id: z.uuid().optional() }),
  z.object({ type: z.literal("answer"), sdp: z.string().max(100000), viewer_id: z.uuid().optional() }),
  z.object({
    type: z.literal("ice"),
    viewer_id: z.uuid().optional(),
    candidate: z
      .object({
        candidate: z.string().max(4096),
        sdpMid: z.string().nullable().optional(),
        sdpMLineIndex: z.number().int().nullable().optional(),
      })
      .nullable(),
  }),
  z.object({ type: z.literal("screen_error"), code: z.string().max(128), viewer_id: z.uuid() }),
]);
type ScreenEnvironment = { readonly DATABASE: Hyperdrive };

export class ScreenRoom extends DurableObject<ScreenEnvironment> {
  private attachment(socket: WebSocket) {
    const parsed = Attachment.parse(socket.deserializeAttachment());
    if (parsed.viewer_id) return parsed;
    const migrated = { ...parsed, viewer_id: crypto.randomUUID() };
    socket.serializeAttachment(migrated);
    return migrated;
  }
  async fetch(request: Request): Promise<Response> {
    if (request.headers.get("Upgrade")?.toLowerCase() !== "websocket")
      return new Response("WebSocket required", { status: 426 });
    const connection = Attachment.safeParse({
      role: request.headers.get("X-Screen-Role"),
      token_hash: request.headers.get("X-Screen-Token-Hash"),
      session_hash: request.headers.get("X-Screen-Session-Hash"),
      vm_id: request.headers.get("X-Screen-VM"),
      workspace_id: request.headers.get("X-Screen-Workspace"),
      last_activity: Date.now(),
      viewer_id: crypto.randomUUID(),
      version: new URL(request.url).searchParams.get("screen_version") === "2" ? 2 : 1,
    });
    if (!connection.success) return new Response("Unauthorized", { status: 401 });
    if (connection.data.role === "vm") {
      for (const previous of this.ctx.getWebSockets("vm"))
        this.closeAndNotify(previous, 1000, "VM reconnected");
    }
    const existing = this.ctx.getWebSockets(connection.data.role).filter(socket => socket.readyState === WebSocket.OPEN && !this.attachment(socket).closing);
    const daemon = this.ctx.getWebSockets("vm").find(socket => socket.readyState === WebSocket.OPEN);
    const legacyDaemon = daemon && this.attachment(daemon).version === 1;
    if (existing.length >= (connection.data.role === "vm" || legacyDaemon ? 1 : MAX_SCREEN_VIEWERS)) {
      if (connection.data.role === "vm")
        return new Response("Screen peer already connected", { status: 409 });
      const rejected = new WebSocketPair();
      rejected[1].accept();
      const code = legacyDaemon ? "viewer_already_connected" : "viewer_limit_reached";
      rejected[1].send(JSON.stringify({ type: "screen_error", code }));
      rejected[1].close(1008, code);
      return new Response(null, { status: 101, webSocket: rejected[0] });
    }
    const pair = new WebSocketPair();
    pair[1].serializeAttachment(connection.data);
    this.ctx.acceptWebSocket(pair[1], [connection.data.role]);
    const machine = connection.data.role === "vm" ? pair[1] : daemon;
    const viewers = connection.data.role === "client" ? [pair[1]] : this.ctx.getWebSockets("client").filter(socket => socket.readyState === WebSocket.OPEN);
    for (const [index, viewer] of viewers.entries()) {
      const client = this.attachment(viewer);
      if (!machine) { viewer.send(JSON.stringify({ type: "peer_waiting" })); continue; }
      const modern = this.attachment(machine).version === 2;
      if (!modern && index > 0) { this.closeAndNotify(viewer, 1008, "legacy_daemon_viewer_limit"); continue; }
      viewer.send(JSON.stringify({ type: "peer_ready", ...(modern ? { version: 2, viewer_id: client.viewer_id } : {}) }));
      machine.send(JSON.stringify({ type: "peer_ready", ...(modern ? { viewer_id: client.viewer_id, version: client.version } : {}) }));
    }
    if (connection.data.role === "vm" && !viewers.length) pair[1].send(JSON.stringify({ type: "peer_waiting" }));
    await this.ctx.storage.setAlarm(Date.now() + 15000);
    return new Response(null, { status: 101, webSocket: pair[0] });
  }

  private async authorized(socket: WebSocket): Promise<boolean> {
    const peer = Attachment.safeParse(socket.deserializeAttachment());
    if (!peer.success) return false;
    const sql = createDatabase(this.env.DATABASE.connectionString);
    try {
      const rows =
        await sql`SELECT c.token_hash FROM assistant.credentials c WHERE c.token_hash=${peer.data.token_hash} AND c.workspace_id=${peer.data.workspace_id} AND c.role=${peer.data.role} AND c.revoked_at IS NULL AND (c.vm_id IS NULL OR c.vm_id=${peer.data.vm_id}) AND (${peer.data.session_hash}::text IS NULL OR EXISTS(SELECT 1 FROM assistant.browser_sessions s WHERE s.token_hash=${peer.data.session_hash} AND s.credential_hash=c.token_hash AND s.revoked_at IS NULL AND s.expires_at>now()))`;
      return rows.length === 1;
    } finally {
      await sql.end();
    }
  }

  async webSocketMessage(socket: WebSocket, message: string | ArrayBuffer): Promise<void> {
    if (typeof message !== "string" || message.length > 110000) {
      socket.close(1009, "Invalid frame");
      return;
    }
    if (!(await this.authorized(socket))) {
      this.closeAndNotify(socket, 1008, "Credential revoked");
      return;
    }
    const peer = this.attachment(socket);
    if (peer.closing || socket.readyState !== WebSocket.OPEN) return;
    socket.serializeAttachment({ ...peer, last_activity: Date.now() });
    if (message === "ping") {
      socket.send("pong");
      return;
    }
    let raw: unknown;
    try {
      raw = JSON.parse(message);
    } catch (error) {
      if (error instanceof SyntaxError) {
        socket.close(1007, "Invalid JSON");
        return;
      }
      throw error;
    }
    const parsed = Frame.safeParse(raw);
    if (!parsed.success) {
      socket.close(1007, "Invalid signaling frame");
      return;
    }
    if (
      (parsed.data.type === "offer" && peer.role !== "client") ||
      (["answer", "screen_error"].includes(parsed.data.type) && peer.role !== "vm")
    ) {
      socket.close(1008, "Wrong signaling role");
      return;
    }
    const targetRole = peer.role === "client" ? "vm" : "client";
    for (const target of this.ctx.getWebSockets(targetRole)) {
      if (target.readyState !== WebSocket.OPEN) continue;
      const recipient = this.attachment(target);
      if (peer.role === "vm" && peer.version === 2 && parsed.data.viewer_id !== recipient.viewer_id) continue;
      const { viewer_id: _ignored, ...frame } = parsed.data;
      target.send(JSON.stringify({ ...frame, ...(peer.role === "client" && recipient.version === 2
        ? { viewer_id: peer.viewer_id, version: peer.version, ...(frame.type === "offer" ? { visible: peer.version === 2 ? frame.visible ?? true : true } : {}) } : {}) }));
    }
  }

  private closeAndNotify(socket: WebSocket, code: number, reason = ""): void {
    const attachment = this.attachment(socket);
    if (attachment.closing) return;
    socket.serializeAttachment({ ...attachment, closing: true });
    const replyCode = [1005, 1006, 1015].includes(code) ? 1000 : code;
    try {
      socket.close(replyCode, reason);
    } finally {
      const replaced = this.ctx
        .getWebSockets(attachment.role)
        .some((peer) => peer !== socket && peer.readyState === WebSocket.OPEN);
      let notified = 0;
      if (attachment.role === "client" || !replaced)
        for (const peer of this.ctx.getWebSockets(attachment.role === "client" ? "vm" : "client")) {
          if (peer !== socket && peer.readyState === WebSocket.OPEN) {
            const recipient = this.attachment(peer);
            if (attachment.role === "client" && recipient.version === 1 && replaced) continue;
            peer.send(JSON.stringify({ type: "peer_left", ...(attachment.role === "client" && recipient.version === 2 ? { viewer_id: attachment.viewer_id } : {}) }));
            notified++;
          }
        }
      console.log(
        JSON.stringify({
          event: "screen.peer_closed",
          role: attachment.role,
          code,
          replaced,
          notified,
        }),
      );
    }
  }

  async webSocketClose(socket: WebSocket, code: number): Promise<void> {
    this.closeAndNotify(socket, code);
  }

  async alarm(): Promise<void> {
    for (const socket of this.ctx.getWebSockets()) {
      if (socket.readyState !== WebSocket.OPEN) continue;
      const peer = Attachment.parse(socket.deserializeAttachment());
      if (!(await this.authorized(socket))) this.closeAndNotify(socket, 1008, "Credential revoked");
      else if (peer.role === "client" && Date.now() - peer.last_activity > 45000)
        this.closeAndNotify(socket, 1001, "Viewer heartbeat expired");
    }
    if (this.ctx.getWebSockets().length) await this.ctx.storage.setAlarm(Date.now() + 15000);
  }
}
