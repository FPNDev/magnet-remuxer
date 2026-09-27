type PendingFlight = {
  promise: Promise<unknown>;
  sharedAbortController: AbortController;
  waiters: Set<AbortSignal>;
};

export type FlightResponse<T> = {
  promise: Promise<T>;
  signal: AbortSignal;
};

export class SingleFlight {
  private readonly pending = new Map<string, PendingFlight>();

  run<T>(
    key: string,
    signal: AbortSignal | undefined,
    task: () => Promise<T>,
  ): FlightResponse<T> {
    let flight = this.pending.get(key);
    if (!flight) {
      const created: PendingFlight = {
        promise: Promise.resolve()
          .then(task)
          .finally(() => {
            this.drop(key, created);
          }),
        sharedAbortController: new AbortController(),
        waiters: new Set(),
      };
      this.pending.set(key, created);
      flight = created;
    }

    if (signal) {
      const { waiters } = flight;
      const current = flight;

      const leave = () => {
        waiters.delete(signal);

        if (waiters.size === 0) {
          this.drop(key, current, true);
        }
      };

      if (signal.aborted) {
        leave();
      } else {
        waiters.add(signal);

        const remove = () => {
          signal.removeEventListener('abort', leave);
        };
        signal.addEventListener('abort', leave, { once: true });

        flight.promise.then(remove, remove);
      }
    }

    return {
      promise: flight.promise as Promise<T>,
      signal: flight.sharedAbortController.signal,
    };
  }

  private drop(key: string, flight: PendingFlight, aborted = false) {
    if (this.pending.get(key) !== flight) {
      return;
    }
    if (aborted) {
      flight.sharedAbortController.abort();
    }
    this.pending.delete(key);
  }
}
