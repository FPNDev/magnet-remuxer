import type { FlightResponse } from './single-flight.js';

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
  work: () => FlightResponse<T>,
  onAbort?: () => unknown,
  onFinally?: () => void,
): Promise<T> {
  const { signal, promise } = work();
  if (!signal) {
    return promise;
  }
  if (signal.aborted) {
    const res = Promise.reject(onAbort?.());
    onFinally?.();

    return res;
  }
  return new Promise<T>((resolve, reject) => {
    const handleAbort = () => {
      reject(onAbort?.());
      onFinally?.();
    };
    signal.addEventListener('abort', handleAbort, { once: true });
    promise.then(resolve, reject).finally(() => {
      signal.removeEventListener('abort', handleAbort);
      onFinally?.();
    });
  });
}
