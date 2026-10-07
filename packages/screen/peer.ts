import {
  MediaStreamTrack,
  type RTCDataChannel,
  type RTCIceServer,
  RTCPeerConnection,
  useVP8,
} from "werift";
import { z } from "zod";
import type { ScreenStage } from "./diagnostic";
import { type InputExecutor, ScreenInput } from "./input";
import { type ControlOwner, type Dimensions, Input, ScreenError, type Signal } from "./protocol";
import { InputLease } from "./input-lease";
import { ViewerCommand } from "./session-protocol";
export type ScreenPeerConfig = {
  readonly owner: ControlOwner;
  readonly dimensions: Dimensions;
  readonly iceServers: RTCIceServer[];
  readonly visible?: boolean;
  readonly viewer?: { readonly id: string; readonly version: 1 | 2; readonly lease: InputLease };
  readonly signal: (value: { readonly type: "answer"; readonly sdp: string }) => void;
  readonly execute: InputExecutor;
  readonly paste?: (text: string, beforeInput: () => void) => Promise<void>;
  readonly capture: (
    track: MediaStreamTrack,
    onFailure: () => void,
  ) => Promise<() => Promise<void>>;
};
export class ScreenPeer {
  readonly pc: RTCPeerConnection;
  readonly track = new MediaStreamTrack({ kind: "video" });
  readonly input: ScreenInput;
  private channel: RTCDataChannel | undefined;
  private stopCapture: (() => Promise<void>) | undefined;
  private mediaQueue: Promise<void> = Promise.resolve();
  private connected = false;
  private visible: boolean;
  private visibilityRevision = 0;
  private readonly claims = new Map<string, Promise<number>>();
  private legacyClaim: Promise<number> | undefined;
  private closed = false;
  private closing: Promise<void> | undefined;
  private registered = false;
  constructor(private readonly config: ScreenPeerConfig) {
    this.visible = config.visible ?? true;
    this.pc = new RTCPeerConnection({
      codecs: { video: [useVP8()] },
      iceServers: config.iceServers,
      iceAdditionalHostAddresses: ["127.0.0.1"],
      maxMessageSize: 16384,
    });
    this.input = new ScreenInput(config);
    config.viewer?.lease.register(config.viewer.id, {
      visible: () => this.visible && this.connected && !this.closed,
      release: () => this.input.releaseInputs(),
      changed: (epoch, held) => { if (!held) this.send({ type: "input_lease", epoch, held }); },
    });
    this.registered = Boolean(config.viewer);
    this.pc.addTrack(this.track);
    this.pc.onDataChannel.subscribe((channel) => {
      if (channel.label !== "input" || this.channel) {
        channel.close();
        return;
      }
      this.channel = channel;
      channel.stateChange.subscribe((state) => {
        if (state === "open") {
          this.send({
            type: "screen",
            ...config.dimensions,
            control: config.owner.control(),
            unicode_input: config.paste ? "utf8_clipboard" : "unavailable",
          });
          if (config.viewer?.version === 2) {
            this.send({ type: "input_lease", epoch: config.viewer.lease.epoch, held: false });
            void this.setVisible(this.visible).catch(() => this.terminate());
          }
        }
      });
      channel.onMessage.subscribe((data) => {
        void this.receive(typeof data === "string" ? data : data.toString("utf8")).then(
          accepted => { if (accepted) this.send({ type: "input_result", accepted: true }); },
          (error) => {
            if (!(error instanceof Error)) throw error;
            this.send({
              type: "input_result",
              accepted: false,
              code:
                error instanceof ScreenError
                  ? error.code
                  : error instanceof z.ZodError || error instanceof SyntaxError
                    ? "invalid_input"
                    : "input_failed",
            });
          },
        );
      });
    });
    this.pc.connectionStateChange.subscribe((state) => {
      this.connected = state === "connected";
      if (!this.connected && config.viewer) void config.viewer.lease.release(config.viewer.id).catch(() => this.terminate());
      if (!this.closed) {
        void this.reconcileMedia().catch((error) => {
          if (!(error instanceof Error)) throw error;
          this.send({ type: "screen_error", code: "capture_failed" });
          this.terminate();
        });
      }
      if (state === "failed" || state === "closed") this.terminate();
    });
  }
  private async receive(data: string): Promise<boolean> {
    if (data.length > 16384) throw new ScreenError("input_too_large");
    const viewer = this.config.viewer;
    if (!viewer || viewer.version === 1) {
      Input.parse(JSON.parse(data));
      if (viewer && !this.legacyClaim) this.legacyClaim = viewer.lease.claimLegacy(viewer.id);
      let epoch = 0;
      try { epoch = await this.legacyClaim ?? 0; }
      finally { this.legacyClaim = undefined; }
      await this.input.receive(data, viewer ? () => viewer.lease.permits(viewer.id, epoch) : undefined);
      return true;
    }
    const command = ViewerCommand.parse(JSON.parse(data));
    switch (command.type) {
      case "screen_visibility": await this.setVisible(command.visible); return false;
      case "input_claim": {
        let claim = this.claims.get(command.command_id);
        if (!claim) {
          if (this.claims.size >= 128) throw new ScreenError("input_claim_limit");
          claim = viewer.lease.claim(viewer.id);
          this.claims.set(command.command_id, claim);
        }
        const epoch = await claim;
        this.send({ type: "input_lease", epoch, held: viewer.lease.permits(viewer.id, epoch), command_id: command.command_id });
        return false;
      }
      case "input_release": await viewer.lease.release(viewer.id, command.epoch); return false;
      case "input_heartbeat": viewer.lease.heartbeat(viewer.id, command.epoch); return false;
      case "input":
        await this.input.receive(JSON.stringify(command.input), () => viewer.lease.permits(viewer.id, command.epoch));
        return true;
    }
  }
  private async setVisible(visible: boolean): Promise<void> {
    this.visible = visible;
    const revision = ++this.visibilityRevision;
    const release = !visible && this.config.viewer ? this.config.viewer.lease.release(this.config.viewer.id) : Promise.resolve();
    await Promise.all([release, this.reconcileMedia()]);
    if (!this.closed && revision === this.visibilityRevision)
      this.send({ type: "screen_visibility", visible });
  }
  private reconcileMedia(): Promise<void> {
    const next = this.mediaQueue.then(async () => {
      if (this.connected && this.visible && !this.closed && !this.stopCapture) {
        this.stopCapture = await this.config.capture(this.track, () => {
          this.send({ type: "screen_error", code: "capture_failed" });
          this.terminate();
        });
      }
      if ((!this.connected || !this.visible || this.closed) && this.stopCapture) {
        const stop = this.stopCapture;
        this.stopCapture = undefined;
        await stop();
      }
    });
    this.mediaQueue = next.catch(() => {});
    return next;
  }
  private send(value: unknown): void {
    if (this.channel?.readyState === "open") this.channel.send(JSON.stringify(value));
  }
  async signal(signal: Signal, onStage: (stage: ScreenStage) => void = () => {}): Promise<void> {
    switch (signal.type) {
      case "offer": {
        onStage("offer_remote_description");
        await this.pc.setRemoteDescription({ type: "offer", sdp: signal.sdp });
        onStage("answer_create");
        const created = await this.pc.createAnswer();
        onStage("answer_local_description");
        await this.pc.setLocalDescription(created);
        const answer = this.pc.localDescription;
        if (!answer) throw new ScreenError("answer_unavailable");
        onStage("answer_send");
        this.config.signal({ type: "answer", sdp: answer.sdp });
        break;
      }
      case "ice":
        onStage("ice_add");
        await this.pc.addIceCandidate(
          signal.candidate
            ? {
                candidate: signal.candidate.candidate,
                ...(signal.candidate.sdpMid !== undefined
                  ? { sdpMid: signal.candidate.sdpMid }
                  : {}),
                ...(signal.candidate.sdpMLineIndex !== undefined
                  ? { sdpMLineIndex: signal.candidate.sdpMLineIndex }
                  : {}),
              }
            : null,
        );
        break;
      case "peer_left":
        await this.close();
        break;
      case "peer_ready":
        break;
      case "peer_waiting":
        break;
      default:
        unreachable(signal);
    }
  }
  async releaseInputs(): Promise<void> {
    await this.input.releaseInputs();
  }
  private terminate(): void {
    void this.close().catch(() => { process.stderr.write("Screen peer cleanup failed.\n"); });
  }
  close(): Promise<void> {
    if (this.closing) return this.closing;
    this.closed = true;
    const closing = this.finishClose();
    this.closing = closing;
    void closing.catch(() => { if (this.closing === closing) this.closing = undefined; });
    return closing;
  }
  private async finishClose(): Promise<void> {
    try {
      if (this.registered && this.config.viewer) {
        this.registered = false;
        await this.config.viewer.lease.unregister(this.config.viewer.id);
      }
    } finally {
      try { await this.reconcileMedia(); }
      finally {
        this.track.stop();
        this.channel?.close();
        try { await this.input.releaseInputs(); }
        finally { await this.pc.close(); }
      }
    }
  }
}
function unreachable(value: never): never {
  throw new ScreenError(`unsupported_signal:${String(value)}`);
}
