![logo](./OLPO.png)

# OLPO - A TypeScript Resource Pool

[![CircleCI](https://circleci.com/gh/twooster/olpo.svg?style=svg)](https://circleci.com/gh/twooster/olpo)
[![codecov](https://codecov.io/gh/twooster/olpo/branch/master/graph/badge.svg)](https://codecov.io/gh/twooster/olpo)

OLPO is yet another TypeScript resource pool. It's written to be small (~5.8k
minified), fast, Promise-native, and written in TypeScript.  It has no
external dependencies and will maintain 100% test coverage.

Requires ES6 support (Node >= 6.4, or a somewhat modern browser). (You may
also cross-compile your own ES5 version by modifying `tsconfig.json`).

## Installation

```sh
npm install --save olpo
```

## Documentation

**Documentation is available [here](https://twooster.github.io/olpo)**

Documentation is updated every version bump. A changelog is available
[here](https://github.com/twooster/olpo/blob/master/CHANGELOG.md).

## Motivation

There's a lot of pools out there. A lot of them have a lot of features,
but don't have the particular intersection of features I wanted.

* Asynchronous support everywhere
* Verification of pool items
* Idle timeouts
* TypeScript ready, and checked

## Usage

Create a pool:

```typescript
import { Pool } from 'olpo'
import { SomeClient } from 'some-client'

const pool = new Pool({
  // Required parameters:

  // Synchronous or asynchronous function that creates pool
  // items.
  create: async () => {
    const cls = new SomeClient()
    await cls.connect()
    return cls
  },
  // Maximum pool size, must be > `min`
  max: 10,

  // Optional parameters:

  // Minimum pool size, must be < `max`
  min: 2,
  // Which promise library to use (uses builtin ES6 Promise by default)
  promise: Bluebird,
  // Default timeout in ms if none is specified as an option during `acquire`
  acquireTimeout: 5000,
  // Timeout in ms past which idle pool items will be `dispose`d of, so long as
  // that disposal doesn't reduce past the minimum pool size
  idleTimeout: 300000,

  // Called to verify a pool item to determine if it's still valid. Can be
  // be synchronous or asynchronous. This function should return `true` or
  // `false`.
  verify(acq) {
    const now = new Date();
    if (acq.uses > 30) {
      return false;
    }
    if (now - acq.createTime > 60000) {
      return false;
    }
    if (now - acq.lastReleaseTime > 20000) {
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
  dispose(acq) {
    console.log('Disposed: ', acq.item)
  },

  // Callbacks. These are mainly event callbacks useful for logging -- be sure
  // not to throw errors from here, as they are not handled within the pooling
  // code:

  // Called immediately before an item is acquired
  onAcquire(acq) {
    console.log('Acquired: ', acq.item)
  },

  // Called immediately after an item has been released, potentially
  // immediately before it's disposed, if necessary
  onRelease(acq) {
    console.log('Released: ', acq.item)
  },

  // Called when an acquire fails (mainly for logging)
  onTimeout({ timeout }) {
    console.log('Timeout hit: ', timeout)
  },

  // Called when an asynchronous error occurs -- `type` can be `'create'`,
  // `'verify'`, or `'dispose'`, indicating errors that occur during those
  // operations
  onError(type, err) {
    console.log('Uncaught error when performing ' + type + ': ' + err)
  }
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

Or acquire them this way (the acquired item is automatically released when the
callback has completed):

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

## License

MIT, available [here](https://github.com/twooster/olpo/blob/master/LICENSE).
