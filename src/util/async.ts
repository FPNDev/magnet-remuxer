/**
 * Rejects with `onTimeout()` if `promise` takes too long. The underlying work
 * carries on — a segment that arrives late is still worth caching.
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
