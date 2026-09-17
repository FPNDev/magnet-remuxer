/** An error that maps directly to an HTTP response status. */
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
 * The request that asked for this work is over - the player moved on, or we
 * ran out of patience - so the work stopped. Never reaches a client: by the
 * time it is thrown there is no response left to write it to.
 */
export class RequestAbandonedError extends Error {
  override name = 'RequestAbandonedError';
}
