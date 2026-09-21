/** Carries a status code to the error middleware. The only way to pick one. */
export class HttpError extends Error {
  override name = 'HttpError';

  constructor(
    readonly status: number,
    message: string,
    options?: ErrorOptions,
  ) {
    super(message, options);
  }
}

/**
 * The client disconnected before the work finished. Not a failure: never
 * logged at error level, never written to a response.
 */
export class RequestAbandonedError extends Error {
  override name = 'RequestAbandonedError';
}
