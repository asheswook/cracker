import type { Signal } from "./protocol";

export type SignalingPeer = {
  signal(value: Signal): Promise<void>;
  releaseInputs(): Promise<void>;
  close(): Promise<void>;
};

export class ScreenSignaling {
  private peer: SignalingPeer | undefined;
  private queue: Promise<void> = Promise.resolve();
  private generation = 0;
  private closing: Promise<void> = Promise.resolve();
  private creation: AbortController | undefined;
  private readonly retiring = new Set<SignalingPeer>();
  constructor(
    private readonly create: (current: () => boolean, signal: AbortSignal, offer: Extract<Signal, { type: "offer" }>) => SignalingPeer | Promise<SignalingPeer>,
    private readonly failure: (error: unknown, frame: Signal["type"]) => void,
  ) {}
  receive(signal: Signal): void {
    if (signal.type === "peer_left") {
      void this.close().catch((error: unknown) => this.failure(error, signal.type));
      return;
    }
    if (signal.type === "offer") {
      const closing = this.close();
      const generation = this.generation;
      const creation = new AbortController();
      this.creation = creation;
      this.queue = closing
        .then(async () => {
          if (generation !== this.generation) return;
          const peer = await this.create(() => generation === this.generation, creation.signal, signal);
          if (generation !== this.generation) {
            await peer.close();
            return;
          }
          this.peer = peer;
          await peer.signal(signal);
        })
        .catch((error: unknown) => this.failed(error, signal.type, generation));
      return;
    }
    const generation = this.generation;
    this.queue = this.queue
      .then(async () => {
        if (generation === this.generation) await this.peer?.signal(signal);
      })
      .catch((error: unknown) => this.failed(error, signal.type, generation));
  }
  private async failed(error: unknown, frame: Signal["type"], generation: number): Promise<void> {
    if (generation !== this.generation) return;
    this.failure(error, frame);
    try {
      await this.close();
    } catch (cleanup: unknown) {
      this.failure(cleanup, "peer_left");
    }
  }
  async releaseInputs(): Promise<void> {
    await this.peer?.releaseInputs();
  }
  close(): Promise<void> {
    this.generation++;
    this.creation?.abort();
    this.creation = undefined;
    const previous = this.peer;
    this.peer = undefined;
    this.queue = Promise.resolve();
    if (previous) this.retiring.add(previous);
    this.closing = this.closing.catch(() => undefined).then(async () => {
      for (const peer of [...this.retiring]) {
        await peer.close();
        this.retiring.delete(peer);
      }
    });
    return this.closing;
  }
}
