/**
 * Pool options
 */
export interface PoolOptions<T> {
  /**
   * Called to create a new pool item. Can be asynchronous or asynchronous.
   * Take care not to throw from this function. If creation could fail,
   * it's recommended that you catch any errors and retry creation until
   * it succeeds. If you need timeouts, you'll need to implement them
   * yourself.
   */
  create: () => PromiseLike<T> | T
  /**
   * Called to verify that an item is still valid for use. Note that this
   * function will be called with a [[VerifiableItem]] -- e.g., a wrapped
   * item with attributes you could use to determine item validity.
   *
   * If this function returns a Promise, that Promise will be awaited for
   * its results. Take care not to throw from this function.
   */
  verify?: (t: InspectableItem<T>) => PromiseLike<boolean> | boolean
  /**
   * Called to dispose of an item. If asynchronous, the results of disposal
   * will be awaited before space in the pool is released. Take care not to
   * throw from this function.
   */
  dispose?: (t: InspectableItem<T>) => PromiseLike<void> | void
  /**
   * The minimum pool size. If this value is greater than zero, then the pool
   * will always guarantee that the pool has at least this many items
   * pre-created. This value must be 0 <= min <= max.
   */
  min?: number
  /**
   * The maximum pool size, or Infinite for no maximum. Must be >= 0.
   * @required
   */
  max: number
  /**
   * The default timeout for acquisitions, or undefined for no timeout.
   * Must be >= 0.
   */
  timeout?: number
  /**
   * A callback that will be called just before an item is successfully
   * acquired from the pool. Take care that this function does not
   * throw.
   */
  onAcquire?: (item: InspectableItem<T>) => void
  /**
   * A callback that will be called just after an item has successfully
   * been released to the pool. Take care that this function does
   * not throw.
   */
  onRelease?: (item: InspectableItem<T>) => void
  /**
   * A callback that will be called if an acquire attempt times out. Take
   * care that this method does not throw.
   */
  onTimeout?: (event: { timeout: number }) => void
  /**
   * Which Promise class to use. Defaults to [[Promise]]
   */
  promise?: PromiseConstructor
}

export interface BaseItem<T> {
  /**
   * Initial creation time of this item
   */
  creationTime: Date
  /**
   * Last acquisition time of this item (or undefined if this item is
   * newly created)
   */
  lastAcquireTime: Date | undefined
  /**
   * Last release time of this item (or undefined if this item is newly
   * created)
   */
  lastReleaseTime: Date | undefined
  /**
   * What time this item was disposed of
   */
  disposedTime: Date | undefined
  /**
   * The number of times this item has been previously acquired (will
   * be zero on first acquisition, until returned).
   */
  uses: number
  /**
   * The item created by the `factory` method
   */
  item: T
  /**
   * Related pool
   */
  pool: Pool<T>
}

interface InternalItem<T> extends BaseItem<T> {
  release: (discard?: boolean) => void
}

export type Item<T> = Readonly<InternalItem<T>>
export type InspectableItem<T> = Readonly<BaseItem<T>>

interface Waiting<T> {
  resolve(t: Item<T>): void
  reject(err: any): void
}

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

const throwDoubleRelease = (): never => { throw new DoubleReleaseError() }

/**
 * The resource Pool class.
 */
export class Pool<T> {
  /**
   * List containing idle items
   * @private
   */
  idle: InternalItem<T>[] = []
  /**
   * List containing all waiting acquisitions
   */
  waiting: Waiting<T>[] = []

  /**
   * The promise constructor to use
   */
  promise: PromiseConstructor
  /**
   * Default acquistion timeout
   */
  timeout: number
  /**
   * Minimum pool size
   */
  min: number
  /**
   * Maximum pool size
   */
  max: number
  /**
   * Item creation function
   */
  createCb: () => PromiseLike<T> | T
  /**
   * Item verification function
   */
  verifyCb?: (t: InspectableItem<T>) => PromiseLike<boolean> | boolean
  /**
   * Item disposal function
   */
  disposeCb?: (item: InspectableItem<T>) => PromiseLike<void> | void
  /**
   * On-acquistion callback
   */
  onAcquire?: (item: InspectableItem<T>) => void
  /**
   * On-release callback
   */
  onRelease?: (item: InspectableItem<T>) => void
  /**
   * On timeout callback
   */
  onTimeout?: (event: { timeout: number }) => void

  /*
   * The current pool size
   */
  poolSize: number = 0
  verifyingCount: number = 0

  /**
   * If set, the pool is currently disposing
   */
  disposing?: {
    promise: Promise<void>
    /**
     * @private
     */
    _resolve: () => void
  } = undefined

  /**
   * Flag that's `true` if the pool has been disposed.
   */
  disposed: boolean = false


  /**
   * Instantiates a Pool class. See [[PoolOptions]] for more information on
   * on configuring the pool.
   *
   * @param options the pool options
   */
  constructor(options: PoolOptions<T>) {
    this.max = options.max
    if (this.max < 0) {
      throw new Error(`Maximum pool size (${this.max}) must be at least 0`)
    }
    this.min = options.min || 0
    if (this.min < 0) {
      throw new Error(`Minimum pool size (${this.min}) must be at least 0`)
    }
    if (this.min > this.max) {
      throw new Error(`Minimum pool size (${this.min}) must be less than or equal to maximum pool size (${this.max}))`)
    }
    this.timeout = options.timeout === undefined ? Infinity : options.timeout
    if (this.timeout < 0) {
      throw new Error(`Minimum timeout (${this.timeout} ms) is 0 ms`)
    }
    this.createCb = options.create
    this.verifyCb = options.verify
    this.disposeCb = options.dispose
    this.onAcquire = options.onAcquire
    this.onTimeout = options.onTimeout
    this.onRelease = options.onRelease
    this.promise = options.promise || Promise

    while (this.poolSize < this.min) {
      this._create()
    }
  }

  /**
   * Acquires an item from the pool. Returns a Promise that resolves to a
   * wrapped `Item` that should be `release`d and returned to the pool after
   * it is no longer required.
   *
   * @param opts options
   * @param opts.timeout timeout in milliseconds before the returned Promise
   *   is rejected
   */
  acquire(opts?: { timeout?: number }): Promise<Item<T>>
  /**
   * Acquires an item from the pool. Calls the provided callback with the
   * (unwrapped) item upon acquisition. Automatically releases the item
   * back to the pool after the callback returns (or throws). Returns
   * the a Promise that resolves to the value of the provided callback.
   *
   * @param cb callback that will receive the item
   * @param opts
   * @param opts.wrappedItem must be false or undefined
   * @param opts.timeout timeout in milliseconds before which this function
   *   rejects its returned Promise with a TimeoutError.
   * @param opts.disposeOnError if true, an error in the callback will
   *   cause the acquired pool item to be disposed
   */
  acquire<U>(cb: (item: T) => U, opts?: { timeout?: number, disposeOnError?: boolean, wrappedItem?: false }): Promise<U>
  /**
   * Acquires an item from the pool. Calls the provided callback with the
   * wrapped item upon acquisition. Automatically releases the item
   * back to the pool after the callback returns (or throws). Returns
   * the a Promise that resolves to the value of the provided callback.
   *
   * Be sure not to explicitly `release` the item, or a double-release
   * error will occur.
   *
   * @param cb callback that will received the wrapped item
   * @param opts
   * @param opts.wrappedItem must be true to receive the unwrapped item
   * @param opts.timeout timeout in milliseconds before which this function
   *   rejects its returned Promise with a TimeoutError.
   * @param opts.disposeOnError if true, a thrown error in the callback will
   *   cause the acquired pool item to be disposed
   */
  acquire<U>(cb: (item: InspectableItem<T>) => U, opts?: { timeout?: number, disposeOnError?: boolean, wrappedItem: true }): Promise<U>
  acquire<U>(
    cbOrOpts?: { timeout?: number } | ((item: T) => U) | ((item: InspectableItem<T>) => U),
    opts?: { timeout?: number, disposeOnError?: boolean, wrappedItem?: boolean }
  ): Promise<Item<T>> | Promise<U> {
    if (this.disposing || this.disposed) {
      return this.promise.reject(new Error('Cannot acquire while the pool is disposing or disposed')) as any
    }

    if (typeof cbOrOpts === 'function') {
      let item: Item<T>
      const disposeOnError = opts && opts.disposeOnError
      const wrappedItem = opts && opts.wrappedItem
      const timeout = opts && opts.timeout !== undefined ? opts.timeout : this.timeout
      return this._acquire(timeout)
        .then(i => {
          item = i
          return wrappedItem ? i : i.item
        })
        .then(cbOrOpts as (p: any) => U)
        .then(result => {
          item.release()
          return result
        }, err => {
          item.release(disposeOnError)
          throw err
        })
    } else {
      const timeout = cbOrOpts && cbOrOpts.timeout !== undefined ? cbOrOpts.timeout : this.timeout
      return this._acquire(timeout)
    }
  }

  _acquire(timeout: number): Promise<Item<T>> {
    if (timeout < 0) {
      return this.promise.reject(Error(`Cannot acquire with a timeout (${timeout} ms) less than 0 ms`))
    }
    return new this.promise<Item<T>>((resolve, reject) => {
      let tid: any

      const waiting: Waiting<T> = {
        resolve: (item: InternalItem<T>): void => {
          if (tid !== undefined) {
            clearTimeout(tid)
            tid = undefined
          }
          item.lastAcquireTime = new Date()
          item.release = (dispose?: boolean): void => {
            this.release(item, dispose)
          }
          this.onAcquire && this.onAcquire(item)
          resolve(item)
        },
        reject: (err: any) => {
          if (tid !== undefined) {
            clearTimeout(tid)
            tid = undefined
          }

          // This is only needed to support disposing while max === 0
          if (this.disposing && this.poolSize === 0) {
            this.disposing._resolve()
          }
          reject(err)
        }
      }

      if (timeout !== undefined && timeout !== Infinity) {
        tid = setTimeout(() => {
          this.waiting.splice(this.waiting.indexOf(waiting), 1)
          waiting.reject(new TimeoutError(timeout))
          this.onTimeout && this.onTimeout({ timeout })
        }, timeout < 0 ? 0 : timeout)
      }

      this.waiting.push(waiting)
      if (this.verifyingCount < this.waiting.length) {
        if (this.idle.length) {
          this._verify(this.idle.pop() as InternalItem<T>)
        } else if (this.poolSize < this.max) {
          this._create()
        }
      }
    })
  }

  /**
   * Releases an item; if  `dispose` is false, the item is returned to the
   * pool. Otherwise, the item is disposed of.
   *
   * @param item the item to release
   * @param dispose if true, disposes of the item, otherwise releases it
   *   back into the pool.
   */
  release(item: InternalItem<T> | Item<T>, dispose?: boolean): void {
    if (item.disposedTime) {
      throw new Error('Cannot release a disposed item')
    }
    if (item.pool !== this) {
      throw new Error('Cannot release an unrelated item into this pool')
    }
    if (item.release === throwDoubleRelease) {
      throw new DoubleReleaseError()
    }

    const now: Date = new Date()
    ;(item as InternalItem<T>).uses += 1
    ;(item as InternalItem<T>).release = throwDoubleRelease
    ;(item as InternalItem<T>).lastReleaseTime = now

    this.onRelease && this.onRelease(item)

    if (dispose) {
      this._dispose(item)
    } else if (this.verifyingCount < this.waiting.length) {
      this._verify(item)
    } else if (this.disposing) {
      this._dispose(item)
    } else {
      this.idle.push(item)
    }
  }

  /**
   * Returns the number of waiting acquisitions.
   */
  waitingCount(): number {
    return this.waiting.length
  }

  /**
   * Disposes of the pool. After this method has been called, any new
   * acquisitions will throw an error.
   *
   * @param rejectWaiting if true, indicates that all waiting acquisition
   *   promises should be rejected with a [[PoolDisposingError]]; otherwise
   *   these pool items will be allowed to resolve as normal
   * @returns a promise that resolves when the pool disposal has completed (all
   *   pending/checked out acquisitions, and all disposals have cleared)
   */
  public dispose(rejectWaiting?: boolean): Promise<void> {
    if (this.disposed) {
      return this.promise.resolve()
    }

    if (!this.disposing) {
      if (this.poolSize === 0) {
        this.disposed = true
        return this.promise.resolve()
      }

      let _resolve: any
      let promise = new this.promise(resolve => {
        _resolve = resolve
      }).then(() => {
        this.disposing = undefined
        this.disposed = true
      })
      this.disposing = { promise, _resolve }
    }

    if (this.idle.length) {
      let idle
      while (idle = this.idle.pop()) {
        this._dispose(idle)
      }
    }

    if (rejectWaiting) {
      let waiting
      while (waiting = this.waiting.pop()) {
        waiting.reject(new PoolDisposingError())
      }
    }

    return this.disposing.promise
  }

  /**
   * Makes an InternalItem
   */
  private _makeItem(item: T): InternalItem<T> {
    return {
      creationTime: new Date(),
      disposedTime: undefined,
      item,
      lastAcquireTime: undefined,
      lastReleaseTime: undefined,
      pool: this,
      release: throwDoubleRelease,
      uses: 0,
    }
  }

  /**
   * Creates a pool item, and handles verification of the item after creation,
   * or automatic disposal if the item is not needed and the pool is in
   * disposal.
   */
  private _create(): void {
    ++this.poolSize
    this.promise.resolve(this.createCb())
      .then(item => {
        const internalItem = this._makeItem(item)
        if (this.verifyingCount < this.waiting.length) {
          this._verify(internalItem)
        } else if (this.disposing) {
          this._dispose(internalItem)
        } else {
          this.idle.push(internalItem)
        }
      })
  }

  /**
   * Verifies that an item is valid for use. Does not protect against double
   * verifications.
   *
   * If verification succeeds, will handle delivering the item on to the next
   * waiting acquisition if available. Otherwise will either add the item to
   * the idle queue, or, if the pool is disposing, will automatically dispose
   * of it.
   *
   * If verification fails, will handle disposal via `_dispose`, which handles
   * recreation if necessary to meet pool demands.
   */
  private _verify(item: InternalItem<T>): void {
    ++this.verifyingCount
    this.promise.resolve(this.verifyCb ? this.verifyCb(item) : true)
      .then(itemIsOk => {
        --this.verifyingCount
        if (itemIsOk) {
          if (this.waiting.length) {
            (this.waiting.shift() as Waiting<T>).resolve(item)
          } else if (this.disposing) {
            this._dispose(item)
          } else {
            this.idle.push(item)
          }
        } else {
          this._dispose(item)
        }
      })
  }

  /**
   * Disposes of an item. Will trigger item recreation if necessary, or
   * potentially resolve the `disposing` promise during pool-disposal.
   */
  private _dispose(item: InternalItem<T>): void {
    this.promise.resolve(this.disposeCb ? this.disposeCb(item) : undefined)
      .then(() => {
        --this.poolSize
        if (this.verifyingCount < this.waiting.length) {
          this._create()
        } else if (this.disposing) {
          if (this.poolSize === 0) {
            this.disposing._resolve()
          }
        } else if (this.poolSize < this.min) {
          this._create()
        }
      })
  }
}
