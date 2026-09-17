/**
 * Rejects with `onTimeout()` if `promise` takes too long.
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
 * Rejects as soon as `signal` aborts, whatever `work` is still doing. `work`
 * keeps its own handlers, so a later failure of it is never unhandled.
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
