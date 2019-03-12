import { TimeoutError, DoubleReleaseError, PoolDisposingError } from './errors'

/**
 * Pool options
 *
 * @typeparam T The type of the objet that the create call generates.
 *   Can generally be inferred from the [[create]] attribute.
 */
export interface PoolOptions<T> {
  /**
   * Called to create a new pool item. Can be asynchronous or asynchronous.
   * If you need creation timeouts, you'll need to implement them yourself.
   */
  create: () => PromiseLike<T> | T
  /**
   * Called to verify that an item is still valid for use. Note that this
   * function will be called with a [[InspectableItem]] -- e.g., a wrapped
   * item with attributes you could use to determine item validity.
   *
   * If this function returns a Promise, that Promise will be awaited for
   * its results.
   */
  verify?: (t: InspectableItem<T>) => PromiseLike<boolean> | boolean
  /**
   * Called to dispose of an item. If asynchronous, the results of disposal
   * will be awaited before space in the pool is released.
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
   * The default timeout for acquisitions, or undefined/Infinity for no
   * timeout. If defined, must be >= 0.
   */
  acquireTimeout?: number
  /**
   * Specifies how long a pool item can remain idle before it is automatically
   * disposed of. Note that if disposal would drop the pool below its minimum
   * size, disposal will typically not occur. If defined, must be >= 0, if
   * undefined or Infinity, no idle timeout will be triggered.
   */
  idleTimeout?: number
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
   * A callback that will be called if there is an error during creation,
   * verification, or disposal of a queue item.
   */
  onError?: (when: 'create' | 'verify' | 'dispose', err: any) => void
  /**
   * Which Promise class to use. Defaults to ES6 `Promise`.
   */
  promise?: PromiseConstructor
}

/**
 * @typeparam T the item type
 */
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
   * Time this item was disposed of, or undefined if it has not been
   * disposed. Typically only useful to see in the `onDispose` callback.
   */
  disposedTime: Date | undefined
  /**
   * The number of times this item has been previously acquired (will
   * be zero on first acquisition).
   */
  uses: number
  /**
   * The item created by the `create` method this pool uses
   */
  item: T
  /**
   * Related [[Pool]]
   */
  pool: Pool<T>
}

/**
 * Full, `release`-able item.
 *
 * @typeparam T the item type
 */
interface ReleasableItem<T> extends BaseItem<T> {
  /**
   * Releases the item back into the pool. If `discard` is true, the
   * item will be discarded instead.
   */
  release: (discard?: boolean) => void
  /**
   * @private
   * @hidden
   */
  idleTimeoutId: any
}

/**
 * Structure that is passed upon acquisition. Can be `release`d.
 *
 * @typeparam T the item type
 */
export type Item<T> = Readonly<ReleasableItem<T>>

/**
 * Structure thas is passed to most callbacks -- the `release` method is not
 * available.
 *
 * @typeparam T the item type
 */
export type InspectableItem<T> = Readonly<BaseItem<T>>

/**
 * Waiting item structure -- basically a decomposed Promise.
 *
 * @typeparam T the item type
 * @hidden
 */
interface Waiting<T> {
  resolve(t: Item<T>): void
  reject(err: any): void
}

/**
 * Options for acquiring a pool item, returning a promise
 */
export interface AcquireOpts {
  /**
   * Timeout in ms before acquisition will be rejected with a
   * [[TimeoutError]]
   */
  timeout?: number
}

/**
 * Options for acquiring a pool item with a callback
 */
export interface AcquireCallbackOpts extends AcquireOpts {
  /**
   * Whether the acquired item should be disposed of if the callback
   * throws an error. Default `false`.
   */
  disposeOnError?: boolean
  /**
   * If true, the "wrapped" [[Item]] will be passed into the callback.
   * If false, the unwrapped, raw item will be passed.
   */
  wrappedItem?: boolean
}

/**
 * @hidden
 */
const throwDoubleRelease = (): never => { throw new DoubleReleaseError() }

/**
 * @hidden
 */
const cancelIdleTimeout = <T>(item: ReleasableItem<T>) => {
  if (item.idleTimeoutId) {
    clearTimeout(item.idleTimeoutId)
    item.idleTimeoutId = undefined
  }
}

/**
 * The resource Pool class.
 *
 * @typeparam T (usually inferred from [[PoolOptions]]) the type of item this
 *   pool produces
 */
export class Pool<T> {
  /**
   * The promise constructor to use
   */
  promise: PromiseConstructor
  /**
   * Default acquistion timeout
   */
  acquireTimeout: number
  /**
   * Idle timeout
   */
  idleTimeout: number
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
  verifyCb: undefined | ((t: InspectableItem<T>) => PromiseLike<boolean> | boolean)
  /**
   * Item disposal function
   */
  disposeCb: undefined | ((item: InspectableItem<T>) => PromiseLike<void> | void)
  /**
   * On-acquistion callback
   */
  onAcquire: undefined | ((item: InspectableItem<T>) => void)
  /**
   * On-release callback
   */
  onRelease: undefined | ((item: InspectableItem<T>) => void)
  /**
   * On timeout callback
   */
  onTimeout: undefined | ((event: { timeout: number }) => void)
  /**
   * On error callback
   */
  onError: undefined | ((when: 'create' | 'verify' | 'dispose', err: any) => void)

  /*
   * The current pool size, counting items checked out, in creation,
   * in verification, and in disposal.
   */
  poolSize: number = 0

  /**
   * If not undefined, the pool is currently disposing
   */
  disposing: undefined | {
    /**
     * A promise that can be awaited for the ultimate dispoal of the pool
     */
    promise: Promise<void>
    /**
     * @hidden
     */
    _resolve: () => void
  } = undefined

  /**
   * Flag that's `true` if the pool has been disposed.
   */
  disposed: boolean = false

  /**
   * Current number of pool items undergoing verification
   * @hidden
   */
  private verifyingCount: number = 0
  /**
   * List containing idle items
   * @hidden
   */
  private idle: ReleasableItem<T>[] = []
  /**
   * List containing all waiting acquisitions
   * @hidden
   */
  private waiting: Waiting<T>[] = []

  /**
   * The number of waiting acquisitions.
   */
  get waitingSize(): number {
    return this.waiting.length
  }

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
    this.acquireTimeout = options.acquireTimeout === undefined ? Infinity : options.acquireTimeout
    if (this.acquireTimeout < 0) {
      throw new Error(`Minimum timeout (${this.acquireTimeout} ms) is 0 ms`)
    }
    this.idleTimeout = options.idleTimeout === undefined ? Infinity : options.idleTimeout
    if (this.idleTimeout < 0) {
      throw new Error(`Minimum idle timeout (${this.idleTimeout}) is 0 ms`)
    }
    this.createCb = options.create
    this.verifyCb = options.verify
    this.disposeCb = options.dispose
    this.onAcquire = options.onAcquire
    this.onTimeout = options.onTimeout
    this.onRelease = options.onRelease
    this.onError = options.onError
    this.promise = options.promise || Promise

    while (this.poolSize < this.min) {
      this._create()
    }
  }

  /**
   * Utility method that either calls the error handler or throws the error
   * (will typically result in uncaught promises)
   * @hidden
   */
  _handleError(when: 'create' | 'verify' | 'dispose', err: any) {
    if (this.onError) {
      this.onError(when, err)
    } else {
      // There is no real way to test this, since it will result in
      // uncaught exceptions. So long as the previous lines are covered,
      // I'm happy that the behavior is correct.
      /* istanbul ignore next */
      throw err
    }
  }

  /**
   * Acquires an item from the pool. Returns a Promise that resolves to a
   * wrapped [[Item]] that should be `release`d and returned to the pool
   * after it is no longer required.
   *
   * @param opts acquire options
   * @returns a promise resolving to the acquired pool item
   */
  acquire(opts?: AcquireOpts): Promise<Item<T>>
  acquire<U>(cb: (item: T) => U, opts?: AcquireCallbackOpts & { wrappedItem?: false }): Promise<U>
  acquire<U>(cb: (item: InspectableItem<T>) => U, opts?: AcquireCallbackOpts & { wrappedItem: true }): Promise<U>
  /**
   * Acquires an item from the pool. Calls the provided callback with the
   * item upon acquisition, and automatically releases it back to the pool
   * after the callback returns (or resolves if it returns a promise).
   *
   * There are two ways to call this method:
   * * If `opts.wrappedItem` is not set, or is false, then the unwrapped
   *   pool item (e.g., of type-param `T`) will be passed to the callback.
   * * If `opts.wrappedItem` is true, then instead the callback will
   *   receive the "wrapped" pool [[Item]], so you can inspect it.
   *
   * @param cb callback that will receive the item
   * @param opts acquire options
   * @returns a promise that resolves to the result of your callback
   */
  acquire<U>(cb: (item: InspectableItem<T> | T) => U, opts?: AcquireCallbackOpts): Promise<U>
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
      const timeout = opts && opts.timeout !== undefined ? opts.timeout : this.acquireTimeout
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
      const timeout = cbOrOpts && cbOrOpts.timeout !== undefined ? cbOrOpts.timeout : this.acquireTimeout
      return this._acquire(timeout)
    }
  }

  /**
   * Utiliy method to acquire an item strictly as a Promise.
   * @hidden
   */
  _acquire(timeout: number): Promise<Item<T>> {
    if (timeout < 0) {
      return this.promise.reject(Error(`Cannot acquire with a timeout (${timeout} ms) less than 0 ms`))
    }
    return new this.promise<Item<T>>((resolve, reject) => {
      let tid: any

      const waiting: Waiting<T> = {
        resolve: (item: ReleasableItem<T>): void => {
          if (tid !== undefined) {
            clearTimeout(tid)
            tid = undefined
          }
          item.lastAcquireTime = new Date()
          item.release = (dispose?: boolean): void =>
            this.release(item, dispose)
          this.onAcquire && this.onAcquire(item)
          resolve(item)
        },
        reject: (err: any) => {
          if (tid !== undefined) {
            clearTimeout(tid)
            tid = undefined
          }
          reject(err)
        }
      }

      if (timeout !== Infinity) {
        tid = setTimeout(() => {
          this.waiting.splice(this.waiting.indexOf(waiting), 1)
          waiting.reject(new TimeoutError(timeout))
          this.onTimeout && this.onTimeout({ timeout })
        }, timeout)
      }

      this.waiting.push(waiting)
      if (this.verifyingCount < this.waiting.length) {
        if (this.idle.length) {
          const idle = this.idle.pop() as ReleasableItem<T>
          cancelIdleTimeout(idle)
          this._verify(idle)
        } else if (this.poolSize < this.max) {
          this._create()
        }
      }
    })
  }

  /**
   * Releases an [[Item]] back into the pool. If  `dispose` is false, the item is
   * returned to the pool. Otherwise, the item is disposed of.
   *
   * @param item the item to release
   * @param dispose if true, disposes of the item, otherwise releases it
   *   back into the pool.
   * @returns a promise that can be awaited that will resolve after the
   *   item has been added back into internal queues, or disposed if
   *   if `dispose` was true or if the pool is currently `disposing`
   */
  release(item: ReleasableItem<T> | Item<T>, dispose?: boolean): void {
    if (item.pool !== this) {
      throw new Error('Cannot release an unrelated item into the pool')
    }
    if (item.release === throwDoubleRelease) {
      throw new DoubleReleaseError()
    }

    return this._release(item as ReleasableItem<T>, !!dispose)
  }

  /**
   * @hidden
   */
  _release(item: ReleasableItem<T>, dispose: boolean): void {
    const now: Date = new Date()
    item.uses += 1
    item.release = throwDoubleRelease
    item.lastReleaseTime = now
    if (this.idleTimeout !== Infinity) {
      item.idleTimeoutId = setTimeout(() => {
        // It's possible that this could mildly over-dispose if another dispoal
        // is already in progress (counting towards the overall poolSize).
        // Accomodating that edge case probably isn't worth the added
        // complexity.
        item.idleTimeoutId = undefined
        if (this.poolSize > this.min) {
          this.idle.splice(this.idle.indexOf(item), 1)
          this._dispose(item)
        }
      }, this.idleTimeout)
    }

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
        cancelIdleTimeout(idle)
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
   * Makes an ReleasableItem associated with this class
   *
   * @hidden
   */
  private _makeItem(item: T): ReleasableItem<T> {
    return {
      creationTime: new Date(),
      disposedTime: undefined,
      idleTimeoutId: undefined,
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
   *
   * @hidden
   */
  private _create(): void {
    ++this.poolSize
    new this.promise<T>(resolve => resolve(this.createCb()))
      .then(item => {
        const internalItem = this._makeItem(item)
        if (this.verifyingCount < this.waiting.length) {
          this._verify(internalItem)
        } else if (this.disposing) {
          this._dispose(internalItem)
        } else {
          this.idle.push(internalItem)
        }
      }, err => {
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
        this._handleError('create', err)
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
   *
   * @hidden
   */
  private _verify(item: ReleasableItem<T>): void {
    ++this.verifyingCount
    new this.promise<boolean>(resolve => resolve(this.verifyCb ? this.verifyCb(item) : true))
      .then(itemIsOk => {
        this._finalizeVerify(item, itemIsOk)
      }, err => {
        this._finalizeVerify(item, false)
        this._handleError('verify', err)
      })
  }

  /**
   * @hidden
   */
  private _finalizeVerify(item: ReleasableItem<T>, itemIsOk: boolean): void {
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
  }

  /**
   * Disposes of an item. Will trigger item recreation if necessary, or
   * potentially resolve the `disposing` promise during pool-disposal.
   *
   * @hidden
   */
  private _dispose(item: ReleasableItem<T>): Promise<void> {
    return new this.promise<void>(resolve => resolve(this.disposeCb ? this.disposeCb(item) : undefined))
      .then(() => {
        this._finalizeDispose()
      }, err => {
        this._finalizeDispose()
        this._handleError('dispose', err)
      })
  }

  /**
   * @hidden
   */
  private _finalizeDispose(): void {
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
  }
}
