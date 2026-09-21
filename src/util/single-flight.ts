export class SingleFlight {
  private readonly pending = new Map<string, Promise<unknown>>();

  /**
   * Callers arriving while key is in flight share its promise. The entry is
   * dropped once it settles, so a later call runs the task again.
   */
  run<T>(key: string, task: () => Promise<T>): Promise<T> {
    const existing = this.pending.get(key);
    if (existing) {
      return existing as Promise<T>;
    }

    const promise = Promise.resolve()
      .then(task)
      .finally(() => this.pending.delete(key));
    this.pending.set(key, promise);
    return promise;
  }
}
