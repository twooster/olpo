/**
 * Pending acquisitions will be rejected with this error if they
 * exceed the allowed timeout.
 */
export class TimeoutError extends Error {
  constructor(timeout: number) {
    super(`Timeout acquiring pool item (${timeout} ms)`)
  }
}

/**
 * Error that will be thrown if a pool item is released more than once
 * back to the pool.
 */
export class DoubleReleaseError extends Error {
  constructor() {
    super('Double release of pool item')
  }
}

/**
 * Pending acquisitions will be rejected with this error if the
 * pool is disposed with `rejectWaiting` as true
 */
export class PoolDisposingError extends Error {
  constructor() {
    super('Pool disposing, all pending acquisitions cancelled')
  }
}
