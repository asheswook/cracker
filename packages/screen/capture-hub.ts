import { MediaStreamTrack, useVP8, Vp8RtpPayload } from "werift";

const ticksPerMillisecond = useVP8().clockRate / 1000;

export class CaptureHub {
  private readonly targets = new Map<MediaStreamTrack, { failed: () => void; fresh: boolean; sequenceOffset: number; timestampOffset: number }>();
  private readonly last = new WeakMap<MediaStreamTrack, { sequence: number; timestamp: number; time: number }>();
  private readonly source = new MediaStreamTrack({ kind: "video" });
  private stop: (() => Promise<void>) | undefined;
  private queue: Promise<void> = Promise.resolve();
  private closed = false;
  constructor(private readonly capture: (track: MediaStreamTrack, failed: () => void) => Promise<() => Promise<void>>, private readonly now: () => number = () => performance.now()) {
    this.source.onReceiveRtp.subscribe(packet => {
      const time = this.now();
      let keyframeStart: boolean | undefined;
      for (const [target, subscription] of this.targets) {
        const previous = this.last.get(target);
        if (subscription.fresh) {
          if (keyframeStart === undefined) {
            const vp8 = Vp8RtpPayload.deSerialize(packet.payload);
            keyframeStart = vp8.payloadHeaderExist && vp8.payload.length >= 3 && vp8.isKeyframe;
          }
          if (!keyframeStart) continue;
          subscription.fresh = false;
          if (previous) {
            subscription.sequenceOffset = (previous.sequence + 1 - packet.header.sequenceNumber) & 0xffff;
            subscription.timestampOffset = (previous.timestamp + Math.max(1, Math.round((time - previous.time) * ticksPerMillisecond)) - packet.header.timestamp) >>> 0;
          }
        }
        const forwarded = packet.clone();
        forwarded.header.sequenceNumber = (forwarded.header.sequenceNumber + subscription.sequenceOffset) & 0xffff;
        forwarded.header.timestamp = (forwarded.header.timestamp + subscription.timestampOffset) >>> 0;
        this.last.set(target, { sequence: forwarded.header.sequenceNumber, timestamp: forwarded.header.timestamp, time });
        target.writeRtp(forwarded);
      }
    });
  }
  async subscribe(track: MediaStreamTrack, failed: () => void): Promise<() => Promise<void>> {
    if (this.closed) throw new Error("capture_hub_closed");
    const subscription = { failed, fresh: true, sequenceOffset: 0, timestampOffset: 0 };
    this.targets.set(track, subscription);
    try { await this.reconcile(); }
    catch (error) { this.targets.delete(track); throw error; }
    let active = true;
    return async () => {
      if (!active) return;
      active = false;
      if (this.targets.get(track) !== subscription) return;
      this.targets.delete(track);
      await this.reconcile();
    };
  }
  private reconcile(): Promise<void> {
    const next = this.queue.then(async () => {
      if (this.targets.size && !this.closed && !this.stop) {
        this.stop = await this.capture(this.source, () => {
          for (const subscription of [...this.targets.values()]) subscription.failed();
        });
      }
      if ((!this.targets.size || this.closed) && this.stop) {
        const stop = this.stop;
        this.stop = undefined;
        await stop();
      }
    });
    this.queue = next.catch(() => {});
    return next;
  }
  async close(): Promise<void> {
    this.closed = true;
    this.targets.clear();
    await this.reconcile();
    this.source.stop();
  }
}
