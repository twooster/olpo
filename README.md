# OLPO - A TypeScript Resource Pool

[![CircleCI](https://circleci.com/gh/twooster/olpo.svg?style=svg)](https://circleci.com/gh/twooster/olpo)
[![codecov](https://codecov.io/gh/twooster/olpo/branch/master/graph/badge.svg)](https://codecov.io/gh/twooster/olpo)

OLPO is yet another TypeScript resource pool. It's written to be small (11k
unminified, 4.3k minified), simple, fast, Promise-native, and written in
TypeScript.  It also has no external dependencies.

Still pretty new. Requires ES6 support.

## Usage

Create a pool:

```typescript
import { Pool } from 'olpo'
import { SomeClass } from 'somewhere'

const pool = new Pool({
  // Required parameters:

  // Synchronous or asynchronous function that creates pool
  // items. Item creation can be synchronous or asynchronous.
  // Rejections and errors are _not_ handled by this library,
  // so your create method should handle errors internally and
  // always retry until creation succeeds.
  create: async () => {
    const cls = new SomeClass()
    await cls.connect()
    return cls
  }
  // Maximum pool size, must be > `min`
  max: 10,

  // Optional parameters:

  // Minimum pool size
  min: 2,
  // Which promise library to use (uses builtin ES6 Promise by default)
  promise: Bluebird,
  // Default timeout if none is specified during `acquire`
  timeout: 5000,

  // Called to verify a pool item to determine if it's still valid. Can be
  // be synchronous or asynchronous. This function should return `true` or
  // `false`. Errors are not handled by the Pool library, so take care to
  // handle them internally.
  verify(acq) {
    const now = new Date();
    if (acq.uses > 30) {
      return false;
    }
    if (now - acq.createTime > 60000) {
      return false;
    }
    if (now - acq.lastRelaseTime > 20000) {
      return false;
    }
    if (now - acq.lastAcquireTime > 10000) {
      return false;
    }
    return Promise.resolve(asyncCheckIsOk(acq.item))
  },

  // Called when disposing of a pool item (due to pool shutdown or
  // if verification fails, or if an item is released to the pool with
  // the `dispose` flag set to true).
  // This method can be synchronous or asynchronous. If asynchronous, the
  // disposal promise will be awaited before space in the pool is released.
  dispose(acq) { console.log('Disposed: ', acq.item) },


  // Callbacks. These are mainly event callbacks useful for logging -- be sure
  // not to throw errors from here, as they are not handled within the pooling
  // code:

  // Called immediately before an item is acquired
  onAcquire(acq) { console.log('Acquired: ', acq.item) },

  // Called immediately after an item has been released, potentially
  // immediately before it's disposed, if necessary
  onRelease(acq) { console.log('Released: ', acq.item) },

  // Called when an acquire fails (mainly for logging)
  onTimeout({ timeout }) { console.log('Timeout hit: ', timeout) },
})
```

And then acquire resources:

```typescript
pool.acquire({ timeout: 1000 }).then(poolItem => {
  const someClassInstance = poolItem.item
  someClassInstance.doStuff()
  // Be sure to release
  poolItem.release()
})
```


Or acquire them this way (automatically released when the callback
has completed):

```typescript
pool.acquire(someClassInstance => {
  someClassInstance.doStuff()
}, { timeout: 1000 })
```

Maybe you want to release a resource but not add it back to the
pool. Easy:

```typescript
pool.acquire({ timeout: 1000 }).then(poolItem => {
  const someClassInstance = poolItem.item
  const wasSuccessful = someClassInstance.doStuff()
  // If `true` is passed to release, it disposes of the returned
  // client
  poolItem.release(!wasSuccessful)
})
```

## Future Work

This pool should be pretty close to feature-complete, however it
is lacking one thing:

* 100% test coverage
