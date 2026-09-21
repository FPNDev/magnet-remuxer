/**
 * Rejects with onTimeout() after timeoutMs. The promise keeps running, so a
 * caller holding a process or a stream still has to tear it down.
 */
export function withTimeout<T>(
  promise: Promise<T>,
  timeoutMs: number,
  onTimeout: () => Error,
): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const timer = setTimeout(() => reject(onTimeout()), timeoutMs);
    promise.then(resolve, reject).finally(() => clearTimeout(timer));
  });
}

/**
 * Rejects with onAbort() as soon as signal fires. Like withTimeout, work is
 * left running; abort the thing that produced it as well.
 */
export function untilAborted<T>(
  work: Promise<T>,
  signal: AbortSignal | undefined,
  onAbort: () => Error,
): Promise<T> {
  if (!signal) {
    return work;
  }
  if (signal.aborted) {
    // The caller never sees this promise, so absorb its rejection here.
    work.catch(() => {});
    return Promise.reject(onAbort());
  }
  return new Promise<T>((resolve, reject) => {
    const abandon = () => reject(onAbort());
    signal.addEventListener('abort', abandon, { once: true });
    work
      .then(resolve, reject)
      .finally(() => signal.removeEventListener('abort', abandon));
  });
}
