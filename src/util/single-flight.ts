/** Collapses concurrent calls with the same key into one execution. */
export class SingleFlight {
  private readonly pending = new Map<string, Promise<unknown>>();

  run<T>(key: string, task: () => Promise<T>): Promise<T> {
    const existing = this.pending.get(key);
    if (existing) return existing as Promise<T>;

    const promise = Promise.resolve()
      .then(task)
      .finally(() => this.pending.delete(key));
    this.pending.set(key, promise);
    return promise;
  }
}
