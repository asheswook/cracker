export type ToolAccess = "read" | "exclusive";
type Waiting = { readonly access: ToolAccess; readonly start: () => void };
export class ToolScheduler {
  private active = 0;
  private exclusive = false;
  private readonly waiting: Waiting[] = [];
  constructor(readonly concurrency = 3) {
    if (!Number.isInteger(concurrency) || concurrency < 1 || concurrency > 8)
      throw new RangeError("Tool concurrency must be 1–8");
  }
  run<T>(access: ToolAccess, signal: AbortSignal, operation: () => Promise<T>): Promise<T> {
    signal.throwIfAborted();
    return new Promise<T>((resolve, reject) => {
      const entry: Waiting = {
        access,
        start: () => {
          signal.removeEventListener("abort", cancel);
          this.active++;
          this.exclusive = access === "exclusive";
          void Promise.resolve()
            .then(() => {
              signal.throwIfAborted();
              return operation();
            })
            .then(resolve, reject)
            .finally(() => {
              this.active--;
              this.exclusive = false;
              this.drain();
            });
        },
      };
      const cancel = () => {
        const index = this.waiting.indexOf(entry);
        if (index >= 0) {
          this.waiting.splice(index, 1);
          reject(signal.reason);
          this.drain();
        }
      };
      signal.addEventListener("abort", cancel, { once: true });
      this.waiting.push(entry);
      this.drain();
    });
  }
  private drain(): void {
    while (this.waiting.length && this.active < this.concurrency && !this.exclusive) {
      const next = this.waiting[0];
      if (!next || (next.access === "exclusive" && this.active > 0)) return;
      this.waiting.shift();
      next.start();
    }
  }
}

export async function scheduledBatch<T, R>(
  items: readonly T[],
  operation: (item: T, signal: AbortSignal) => Promise<R>,
  parent: AbortSignal,
): Promise<R[]> {
  const abort = new AbortController(),
    signal = AbortSignal.any([parent, abort.signal]);
  const results = await Promise.allSettled(
    items.map(async (item) => {
      try {
        return await operation(item, signal);
      } catch (error) {
        abort.abort(error);
        throw error;
      }
    }),
  );
  const failure = results.find((result) => result.status === "rejected");
  if (failure?.status === "rejected") throw failure.reason;
  return results.flatMap((result) => (result.status === "fulfilled" ? [result.value] : []));
}
