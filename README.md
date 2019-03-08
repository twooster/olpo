# OLPO - A TypeScript Resource Pool

[![CircleCI](https://circleci.com/gh/twooster/olpo.svg?style=svg)](https://circleci.com/gh/twooster/olpo)

OLPO is yet another TypeScript resource pool. It's written to be small (5.8k
unminified), fast, Promise-native, and written in TypeScript.

Still pretty beta. Requires ES6 support.

## Usage

Create a pool:

```typescript
import { Pool } from 'olpo'
import { SomeClass } from 'somewhere'

const pool = new Pool({
  // Required parameters:

  // Synchronous factory method that creates new instances
  factory: () => new SomeClass()
  // Maximum pool size
  max: 10,

  // Optional parameters:
  // Minimum pool size
  min: 2,
  // Which promise library to use (ES6 Promise by default)
  promise: Bluebird,
  // Default timeout if none is specified
  timeout: 5000,

  // Called to "verify" a client to determine if an item is still valid
  // before it's allowed to be acquired; can be synchronous or asynchronous is
  // still valid
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

  // Callbacks -- be sure not to throw errors from here, as they
  // are not handled within the pooling code:

  // Called immediately beore an item is
  onAcquire(acq) { console.log('Acquired: ', acq.item) },

  // Called when an item has been released
  onRelease(acq) { console.log('Released: ', acq.item) },

  // Called when an item fails verification, or when released
  // back to the pool with the dispose flag
  onDispose(acq) { console.log('Disposed: ', acq.item) },

  // Called when an acquire fails
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

* A few more, and more robust, tests
* Asynchronous create method?
* That's about it. It doesn't need to do much.
