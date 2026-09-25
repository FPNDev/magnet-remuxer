type PendingFlight = {
  promise: Promise<unknown>;
  sharedAbortController: AbortController;
};

export type FlightResponse<T> = {
  promise: Promise<T>;
  signal: AbortSignal;
};

export class SingleFlight {
  private readonly pending = new Map<string, PendingFlight>();
  private readonly waiters = new Map<string, Set<AbortSignal>>();

  run<T>(
    key: string,
    signal: AbortSignal | undefined,
    task: () => Promise<T>,
  ): FlightResponse<T> {
    if (signal) {
      const waiters = this.waiters.get(key) || new Set();
      waiters.add(signal);

      signal.addEventListener(
        'abort',
        () => {
          waiters.delete(signal);

          if (!waiters.size) {
            this.drop(key, true);
          }
        },
        { once: true },
      );
    }

    const existing = this.pending.get(key);
    if (existing) {
      return {
        promise: existing.promise as Promise<T>,
        signal: existing.sharedAbortController.signal,
      };
    }

    const sharedAbortController = new AbortController();
    const promise = Promise.resolve()
      .then(task)
      .finally(() => this.drop(key));

    this.pending.set(key, {
      promise,
      sharedAbortController,
    });

    return { promise, signal: sharedAbortController.signal };
  }

  drop(key: string, aborted = false) {
    const pending = this.pending.get(key);
    if (!pending) {
      return;
    }
    if (aborted) {
      pending.sharedAbortController.abort();
    }
    this.pending.delete(key);
  }
}
