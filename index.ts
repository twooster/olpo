/**
 * Pool options
 */
export interface PoolOptions<T> {
  /**
   * Required factory function. It can return an object, or a promise that will
   * eventually resolve to an object.
   */
  factory: () => PromiseLike<T> | T
  /**
   * Which Promise class to use (defaults to ES6 Promise)
   */
  promise?: PromiseConstructor
  /**
   * Function that will be called to "verify" the viability of a pool resource
   * immediately before acquisition. It's passed an `UnreleasableItem` structure,
   * which allows consumers to reject the pool item based not only on its
   * attributes, but also on the number of uses, total lifetime, etc.
   *
   * If this function returns a Promise, that Promise will be awaited for
   * its results.
   */
  verify?: (t: InspectableItem<T>) => PromiseLike<boolean> | boolean
  /**
   * The maximum pool size, or Infinite for no maximum
   * @required
   */
  max: number
  /**
   * The minimum pool size. If this value is greater than zero, then the pool
   * will always guarantee that the pool has at least this many items
   * pre-created. This value must be less than `max`.
   */
  min?: number
  /**
   * The default timeout for acquisitions, or undefined for no timeout.
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
   * A callback that will be called just after an item has been "disposed" of
   * -- that is, it has failed verification, or was released back to the
   * queue with the "dispose" flag set to true. Take care that this
   * method does not throw.
   */
  onDispose?: (item: InspectableItem<T>) => void
  /**
   * A callback that will be called if an acquire attempt times out. Take
   * care that this method does not throw.
   */
  onTimeout?: (event: { timeout: number }) => void
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
 * A call to `acquire` may result in a timeout, in which case
 * the promise returned by `acquire` will reject with this error.
 */
export class TimeoutError extends Error {
  constructor(timeout: number) {
    super('Timeout acquiring pool item (' + timeout + ' ms)')
  }
}

/**
 * This error is thrown when an item that has already been released
 * to the pool is re-released to the pool without first being acquired.
 */
export class DoubleReleaseError extends Error {
  constructor() {
    super('Double release')
  }
}

const alwaysTrue = () => true
const noop = () => undefined
const throwDoubleRelease = (): never => { throw new DoubleReleaseError() }



/**
 * The resource Pool class.
 */
export class Pool<T> {
  idle: InternalItem<T>[] = []
  waiting: Waiting<T>[] = []
  verify: (t: InspectableItem<T>) => PromiseLike<boolean> | boolean
  factory: () => PromiseLike<T> | T
  timeout?: number
  promise: PromiseConstructor
  max: number
  min: number
  checkedOut: number = 0
  verifying: number = 0
  creating: number = 0
  onAcquire: (item: InspectableItem<T>) => void
  onRelease: (item: InspectableItem<T>) => void
  onDispose: (item: InspectableItem<T>) => void
  onTimeout: (event: { timeout: number }) => void

  /**
   * Instantiates a Pool class. See PoolOptions for more information.
   */
  constructor(options: PoolOptions<T>) {
    this.max = options.max
    this.min = options.min || 0
    if (this.min > this.max) {
      throw new Error('Minimum pool size greater than maximum pool size')
    }
    this.factory = options.factory
    this.timeout = options.timeout
    this.verify = options.verify || alwaysTrue
    this.onAcquire = options.onAcquire || noop
    this.onTimeout = options.onTimeout || noop
    this.onRelease = options.onRelease || noop
    this.onDispose = options.onDispose || noop
    this.promise = options.promise || Promise

    this._pulseQueue()
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
   * @param cb
   * @param opts
   * @param opts.timeout timeout in milliseconds before which this function
   *   rejects its returned Promise with a TimeoutError.
   * @param opts.disposeOnError if true, an error in the callback will
   *   cause the acquired pool item to be disposed
   */
  acquire<U>(cb: (item: T) => U, opts?: { timeout?: number, disposeOnError?: boolean, resolveItem?: false }): Promise<U>
  /**
   * Acquires an item from the pool. Calls the provided callback with the
   * unwrapped item upon acquisition. Automatically releases the item
   * back to the pool after the callback returns (or throws). Returns
   * the a Promise that resolves to the value of the provided callback.
   *
   * @param cb
   * @param opts
   * @param opts.resolveItem must be true
   * @param opts.timeout timeout in milliseconds before which this function
   *   rejects its returned Promise with a TimeoutError.
   * @param opts.disposeOnError if true, an error in the callback will
   *   cause the acquired pool item to be disposed
   */
  acquire<U>(cb: (item: Item<T>) => U, opts?: { timeout?: number, disposeOnError?: boolean, resolveItem: true }): Promise<U>
  acquire<U>(
    cbOrOpts?: { timeout?: number } | ((item: T) => U) | ((item: Item<T>) => U),
    opts?: { timeout?: number, disposeOnError?: boolean, resolveItem?: boolean }
  ): Promise<Item<T>> | Promise<U> {
    if (typeof cbOrOpts === 'function') {
      let item: Item<T>
      const disposeOnError = opts && opts.disposeOnError
      const resolveItem = opts && opts.resolveItem
      return this.acquire(opts)
        .then(i => {
          item = i
          return resolveItem ? i : i.item
        })
        .then(cbOrOpts as (p: any) => U)
        .then(result => {
          item.release()
          return result
        }, err => {
          item.release(disposeOnError)
          throw err
        })
    }

    const timeout = cbOrOpts && cbOrOpts.timeout !== undefined ? cbOrOpts.timeout : this.timeout
    return new this.promise<Item<T>>((resolve, reject) => {
      let tid: any

      const waiting: Waiting<T> = {
        resolve: (item: InternalItem<T>): void =>  {
          if (tid !== undefined) {
            clearTimeout(tid)
          }
          ++this.checkedOut
          item.lastAcquireTime = new Date()
          item.release = (dispose?: boolean): void => this.release(item, dispose)
          this.onAcquire && this.onAcquire(item)
          resolve(item)
        },
        reject
      }

      if (timeout !== undefined && timeout !== Infinity) {
        tid = setTimeout(() => {
          this.waiting.splice(this.waiting.indexOf(waiting), 1)
          waiting.reject(new TimeoutError(timeout))
          this.onTimeout && this.onTimeout({ timeout })
        }, timeout < 0 ? 0 : timeout)
      }

      this.waiting.push(waiting)
      this._pulseQueue()
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

    --this.checkedOut


    const now: Date = new Date()
    ;(item as InternalItem<T>).uses += 1
    ;(item as InternalItem<T>).release = throwDoubleRelease
    ;(item as InternalItem<T>).lastReleaseTime = now

    this.onRelease && this.onRelease(item)

    if (dispose) {
      ;(item as InternalItem<T>).disposedTime = now
      this.onDispose && this.onDispose(item)
    } else {
      this.idle.push(item)
    }
    this._pulseQueue()
  }

  /**
   * Returns the current active pool size.
   */
  public poolSize(): number {
    return (this.verifying + this.checkedOut + this.idle.length)
  }

  /**
   * Returns the number of waiting acquisitions.
   */
  public waitingSize(): number {
    return this.waiting.length
  }

  /**
   * Simple item building helper function
   * @private
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
   * Creates an item and either pushes it to the idle pool
   * if creation was synchronous, or increments the internal
   * creating counter and awaits the async results.
   *
   * @private
   */
  private _create(): void {
    const item = this.factory()
    if (item && typeof item === 'object' && 'then' in item) {
      ++this.creating
      item.then(item => {
        --this.creating
        this.idle.push(this._makeItem(item))
        this._pulseQueue()
      }, () => {
        --this.creating
        this._pulseQueue()
      })
    } else {
      this.idle.push(this._makeItem(item as T))
    }
  }

  /**
   * Verifies an item is still good for use. If verification can be
   * performed synchronously, and it fails, this method will return
   * `true` indicating that another item could be created. Otherwise, this
   * function returns false, indicating that verification was either
   * successful or is still pending.
   *
   * @private
   */
  private _verify(item: InternalItem<T>): boolean {
    const verify = this.verify(item)
    if (typeof verify === 'boolean') {
      if (verify) {
        (this.waiting.shift() as Waiting<T>).resolve(item)
      } else {
        item.disposedTime = new Date()
        this.onDispose && this.onDispose(item)
        return true
      }
    } else {
      ++this.verifying
      verify.then(verify => {
        --this.verifying
        if (verify) {
          if (this.waiting.length) {
            (this.waiting.shift() as Waiting<T>).resolve(item)
          } else {
            this.idle.push(item)
          }
        } else {
          item.disposedTime = new Date()
          this.onDispose && this.onDispose(item)
          this._pulseQueue()
        }
      }, err => {
        --this.verifying
        throw err
      })
    }
    return false
  }

  /**
   * Pulses the queue:
   * 1. Ensures that the queue has its minimum number of items
   * 2. Creates items (up to `max`) to attempt to fulfill waiting acquisitions
   * 3. Kicks off verifications to fulfill waiting acquisitions
   *
   * @private
   */
  private _pulseQueue(): void {
    while (true) {
      const canCreate = this.max - (this.verifying + this.creating + this.checkedOut + this.idle.length)
      const waiting = this.waiting.length - this.verifying
      const desired = waiting > this.min ? waiting : this.min

      let toCreate = canCreate < desired ? canCreate : desired
      while (toCreate > 0) {
        --toCreate
        this._create()
      }

      let couldRecreate: boolean = false

      let toVerify = waiting < this.idle.length ? waiting : this.idle.length
      while (toVerify > 0) {
        --toVerify
        couldRecreate = this._verify(this.idle.pop() as InternalItem<T>) || couldRecreate
      }

      if (!couldRecreate) {
        return
      }
    }
  }
}
