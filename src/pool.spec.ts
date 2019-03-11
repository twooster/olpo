import { TimeoutError, PoolDisposingError } from './errors'
import { Pool } from './pool'

describe('Pool', () => {
  describe('constructor', () => {
    test('throws an error with a minimum pool size < 0', () => {
      expect(() => new Pool({
        create: () => 0,
        min: -1,
        max: 1
      })).toThrow()
    })

    test('throws an error with a timeout < 0', () => {
      expect(() => new Pool({
        create: () => 0,
        timeout: -1,
        max: 1
      })).toThrow()
    })

    test('throws an error with max < 0', () => {
      expect(() => new Pool({
        create: () => 0,
        max: -1
      })).toThrow()
    })

    test('throws an error with min > max', () => {
      expect(() => new Pool({
        create: () => 0,
        min: 2,
        max: 1
      })).toThrow()
    })

    it('auto-creates to suit minimum pool size', () => {
      let i = 0
      const p = new Pool({
        create: () => i++,
        min: 3,
        max: 10
      })

      expect(p.poolSize).toEqual(3)
      expect(i).toEqual(3)
    })
  })

  describe('#acquire', () => {
    it('handles timeouts under verification time', async () => {
      let i = 0
      const p = new Pool({
        create: () => i++,
        verify: () => new Promise(resolve => setTimeout(() => resolve(true), 10)),
        max: 10
      })

      const item1Promise = expect(p.acquire({ timeout: 5 })).rejects.toThrow()
      const item2Promise = expect(p.acquire({ timeout: 5 })).rejects.toThrow()
      await item1Promise
      await item2Promise

      expect(i).toEqual(2)

      await p.acquire(() => {})
    })

    describe('with no callback', () => {
      describe('timeouts', () => {
        beforeAll(() => jest.useFakeTimers())
        afterAll(() => jest.useRealTimers())

        test('acquire times out correctly', async () => {
          const p = new Pool({
            create: () => {},
            max: 1
          })
          const item1 = await p.acquire({ timeout: 1000 })

          const item2Promise = p.acquire({ timeout: 1000 })
          jest.runAllTimers()
          await expect(item2Promise).rejects.toThrow()

          item1.release()
        })

        test('acquire with callback times out correctly', async () => {
          const p = new Pool({
            create: () => {},
            max: 1
          })
          const inner = jest.fn(() => {
            expect(p.acquire(() => {}, { timeout: 1000 })).rejects.toThrow()
            jest.runAllTimers()
          })
          await p.acquire(inner, { timeout: 1000 })
          await expect(inner).toBeCalled()
        })

        test('it falls back to the default timeout', async () => {
          // Sigh, jest timers suck or are at least unintuitive to use
          jest.useRealTimers()

          const p = new Pool({
            create: () => {},
            verify: () => new Promise(resolve => setTimeout(() => resolve(true), 20)),
            max: 1,
            timeout: 10
          })

          const item1Promise = p.acquire()
          const item2Promise = p.acquire({ timeout: 30 })
          await expect(item1Promise).rejects.toThrow(TimeoutError)
          await expect(item2Promise).resolves.not.toThrow()
        })
      })

      test('acquire order is not tied to verification order, is fifo', async () => {
        let timeout = 30
        let i = 0
        const p = new Pool({
          create: () => i++,
          max: 10,
          verify: () => new Promise(resolve => {
            timeout -= 5
            setTimeout(() => resolve(true), timeout)
          })
        })

        const promise = Promise.all([
          p.acquire().then(item => { item.release(); return item.item }),
          p.acquire().then(item => { item.release(); return item.item }),
          p.acquire().then(item => { item.release(); return item.item })
        ])

        await expect(promise).resolves.toEqual([2, 1, 0])
      })

      test('items can be released', async () => {
        const p = new Pool({
          create: () => 0,
          max: 1
        })

        await p.acquire().then(item => {
          item.release()
        })
      })

      test('items can be disposed via release, resulting in new items', async() => {
        let i = 0
        const p = new Pool({
          create: () => i++,
          max: 1
        })

        await p.acquire().then(item => {
          expect(item.item).toEqual(0)
          item.release()
        })

        await p.acquire().then(item => {
          expect(item.item).toEqual(0)
          item.release(true)
        })

        await p.acquire().then(item => {
          expect(item.item).toEqual(1)
          item.release()
        })

        await p.acquire().then(item => {
          expect(item.item).toEqual(1)
          item.release()
        })
      })

      test('it increments the uses count each time', async () => {
        const p = new Pool({
          create: () => 0,
          max: 1
        })

        await p.acquire().then(item => {
          expect(item.uses).toEqual(0)
          item.release()
        })

        await p.acquire().then(item => {
          expect(item.uses).toEqual(1)
          item.release()
        })

        expect.assertions(2)
      })

      test('it sets the creationTime', async () => {
        const p = new Pool({
          create: () => 0,
          max: 1
        })

        await p.acquire().then(item => {
          expect(item.creationTime).toBeTruthy()
          item.release()
        })

        expect.assertions(1)
      })

      test('it sets lastAcquireTime', async () => {
        const p = new Pool({
          create: () => 0,
          max: 1
        })

        let firstTime: Date
        await p.acquire().then(item => {
          expect(item.lastAcquireTime).toBeTruthy()
          firstTime = item.lastAcquireTime as Date
          item.release()
        })
        await new Promise(resolve => setTimeout(resolve, 2))

        let secondTime: Date
        await p.acquire().then(item => {
          expect(item.lastAcquireTime).toBeTruthy()
          expect((item.lastAcquireTime as Date).valueOf()).toBeGreaterThan(firstTime.valueOf())
          secondTime = item.lastAcquireTime as Date
          item.release()
        })
        await new Promise(resolve => setTimeout(resolve, 2))

        await p.acquire().then(item => {
          expect(item.lastAcquireTime).toBeTruthy()
          expect((item.lastAcquireTime as Date).valueOf()).toBeGreaterThan(secondTime.valueOf())
          item.release()
        })
        expect.assertions(5)
      })

      test('it sets lastReleaseTime', async () => {
        const p = new Pool({
          create: () => 0,
          max: 1
        })

        await p.acquire().then(item => {
          expect(item.lastReleaseTime).toBeUndefined()
          item.release()
        })

        let firstTime: Date
        await p.acquire().then(async item => {
          expect(item.lastReleaseTime).not.toBeUndefined()
          firstTime = item.lastReleaseTime as Date
          await new Promise(resolve => setTimeout(resolve, 2))
          item.release()
        })

        await p.acquire().then(item => {
          expect(item.lastReleaseTime).not.toBeUndefined()
          expect((item.lastReleaseTime as Date).valueOf()).toBeGreaterThan(firstTime.valueOf())
          item.release()
        })

        expect.assertions(4)
      })

      test('an item is not checked out more than once simultaneously', async () => {
        const p = new Pool({
          create: () => 0,
          max: 1
        })

        let checkedOut = false
        const acqFunction = jest.fn(async (acq: any) => {
          expect(checkedOut).toEqual(false)
          checkedOut = true
          await new Promise(resolve => setImmediate(resolve))
          checkedOut = false
          acq.release()
        })

        await Promise.all([
          p.acquire().then(acqFunction),
          p.acquire().then(acqFunction),
          p.acquire().then(acqFunction),
          p.acquire().then(acqFunction),
          p.acquire().then(acqFunction),
        ])

        expect(acqFunction).toBeCalledTimes(5)
      })

      test('acquisitions grab the most recently available item', async () => {
        let i = 0
        const p = new Pool({
          create: () => i++,
          max: 3
        })

        // Acq 0, release after p1
        const p0 = p.acquire().then(async i => {
          await p1
          i.release()
          return i.item
        })
        // Acq 1, release first
        const p1 = p.acquire().then(async i => {
          i.release()
          return i.item
        })
        // Acq 2, release after p0
        const p2 = p.acquire().then(async i => {
          await p0
          i.release()
          return i.item
        })
        // Acq 1, release after p??
        const p3 = p.acquire().then(async i => {
          await p5
          i.release()
          return i.item
        })
        // Acq 0,
        const p4 = p.acquire().then(async i => {
          await p5
          i.release()
          return i.item
        })
        // Acq 2,
        const p5 = p.acquire().then(async i => {
          await p2
          i.release()
          return i.item
        })

        await expect(Promise.all([
          p0, p1, p2, p3, p4, p5
        ])).resolves.toEqual([0, 1, 2, 1, 0, 2])
      })
    })

    describe('with a unwrapped item callback', () => {
      test('returns a promise of the value the inner function returns', async () => {
        const p = new Pool({
          create: () => 0,
          max: 1
        })

        await expect(p.acquire(() => 'val')).resolves.toEqual('val')
        await expect(p.acquire(() => 'val1')).resolves.toEqual('val1')
      })

      test('the callback is passed the unwrapped item', async () => {
        const obj = {}
        const p = new Pool({
          create: () => obj,
          max: 1
        })

        const fn = jest.fn()
        await p.acquire(fn)
        expect(fn).toBeCalledWith(obj)
      })

      test('disposeOnError disposes on error', async () => {
        const dispose = jest.fn()

        let i = 0
        const p = new Pool({
          create: () => i++,
          dispose,
          max: 1
        })

        const item1 = p.acquire(() => {
          throw new Error('Oopsie')
        }, { disposeOnError: true })

        await expect(item1).rejects.toThrow()
        await expect(dispose).toHaveBeenCalled()

        await expect(p.acquire(() => {
          return 1
        })).resolves.toEqual(1)
      })
    })

    describe('with a wrapped item callback', () => {
      test('returns a promise of the value the inner function returns', async () => {
        const p = new Pool({
          create: () => 0,
          max: 1
        })

        await expect(p.acquire(() => 'val', { wrappedItem: true })).resolves.toEqual('val')
      })

      test('the callback is called with a wwrapped item', async () => {
        const obj = {}
        const p = new Pool({
          create: () => obj,
          max: 1
        })

        await p.acquire(item => {
          expect(item.item).toEqual(obj)
        }, { wrappedItem: true })

        expect.assertions(1)
      })

      test('the item can be checked out more than once, does not exceed max', async () => {
        let i = 0
        const p = new Pool({
          create: () => i++,
          max: 1
        })

        expect(Promise.all([
          p.acquire(val => val.item, { wrappedItem: true }),
          p.acquire(val => val.item, { wrappedItem: true }),
        ])).resolves.toEqual([0, 0])
      })
    })
  })

  describe('create callback', () => {
    test('can be synchronous', async () => {
      let i = 0
      const p = new Pool({
        create: () => i++,
        max: 3
      })

      await expect(Promise.all([
        p.acquire(i => i),
        p.acquire(i => i),
        p.acquire(i => i),
      ])).resolves.toEqual([0, 1, 2])
    })

    test('can be asynchronous', async() => {
      let i = 0
      const p = new Pool({
        create: async () => i++,
        max: 3
      })

      await expect(Promise.all([
        p.acquire(i => i),
        p.acquire(i => i),
        p.acquire(i => i),
      ])).resolves.toEqual([0, 1, 2])
    })

    test('does not over-create with asynchronous create', async () => {
      let i = 0
      const p = new Pool({
        create: () => {
          return new Promise(resolve => setImmediate(() => resolve(i++)))
        },
        max: 1
      })

      await expect(Promise.all([
        p.acquire(i => i),
        p.acquire(i => i),
        p.acquire(i => i),
      ])).resolves.toEqual([0, 0, 0])
    })
  })

  describe('verify callback', () => {
    test('supports synchronous verification', async () => {
      let i = 0
      let j = 0

      const p = new Pool({
        create: () => i++,
        max: 1,
        verify: () => j++ % 3 < 2
      })
      const item1 = await p.acquire()
      expect(item1.item).toEqual(0)
      item1.release()

      const item2 = await p.acquire()
      expect(item2.item).toEqual(0)
      item2.release()

      const item3 = await p.acquire()
      expect(item3.item).toEqual(1)
      item3.release()

      const item4 = await p.acquire()
      expect(item4.item).toEqual(1)
      item4.release()
    })

    test('supports asynchronous verification', async () => {
      let i = 0
      let j = 0

      const p = new Pool({
        create: () => i++,
        max: 1,
        verify: () => new Promise(resolve => setImmediate(() => resolve(j++ % 3 < 2)))
      })
      const item1 = await p.acquire()
      expect(item1.item).toEqual(0)
      item1.release()

      const item2 = await p.acquire()
      expect(item2.item).toEqual(0)
      item2.release()

      const item3 = await p.acquire()
      expect(item3.item).toEqual(1)
      item3.release()

      const item4 = await p.acquire()
      expect(item4.item).toEqual(1)
      item4.release()
    })

    test('dispose is called for items that fail validation', async () => {
      let i = 0
      let j = 0
      const dispose = jest.fn()
      const p = new Pool({
        create: () => i++,
        max: 1,
        verify: () => j++ % 2 === 0,
        dispose
      })

      const item1 = await p.acquire()
      item1.release()

      expect(dispose).not.toHaveBeenCalled()

      const item2 = await p.acquire()
      expect(dispose).toHaveBeenCalled()
      item2.release()

      expect(dispose).toHaveBeenCalledTimes(1)
    })
  })

  test('it resolves in order', async () => {
    const p = new Pool({
      create: () => {},
      max: 1,
    })

    return expect(Promise.all([
      p.acquire().then(i => {
        i.release()
        return 0
      }),

      p.acquire().then(i => {
        i.release()
        return 1
      }),

      p.acquire().then(i => {
        i.release()
        return 2
      }),
    ])).resolves.toEqual([0, 1, 2])
  })

  test('acquires and releases in the right order', async () => {
    let i = 0
    const p = new Pool({
      create: () => i++,
      max: 2
    })

    const item1 = await p.acquire()
    const item2 = await p.acquire()

    expect(item1.item).not.toEqual(item2.item)

    const item3Promise = p.acquire()
    item1.release()

    const item3 = await item3Promise
    expect(item3.item).toEqual(item1.item)
  })

  describe('#release', () => {
    test('it releases', async () => {
      let i = 0
      const p = new Pool({
        create: () => i++,
        max: 1
      })

      const item = await p.acquire()
      expect(item.item).toEqual(0)
      p.release(item)

      const item1 = await p.acquire()
      expect(item1.item).toEqual(0)
      p.release(item)
    })

    test('it can dispose', async () => {
      let i = 0
      const p = new Pool({
        create: () => i++,
        max: 1
      })

      const item = await p.acquire()
      expect(item.item).toEqual(0)
      p.release(item)

      const item1 = await p.acquire()
      expect(item1.item).toEqual(0)
      p.release(item1, true)

      const item2 = await p.acquire()
      expect(item2.item).toEqual(1)
      p.release(item2)

      const item3 = await p.acquire()
      expect(item3.item).toEqual(1)
      p.release(item3)
    })

    test('it throws on double-release', async () => {
      const p = new Pool({
        create: () => {},
        max: 1
      })
      const item = await p.acquire()
      p.release(item)
      expect(() => p.release(item)).toThrow()
    })

    test('it recreates after disposing with a minimum pool size', async () => {
      let i = 0
      const p = new Pool({
        create: () => i++,
        min: 2,
        max: 2
      })

      const item1 = await p.acquire()
      item1.release(true)

      await new Promise(resolve => setImmediate(resolve))
      expect(i).toEqual(3)

      const item2 = await p.acquire()
      const item3 = await p.acquire()

      item2.release()
      item3.release()
    })
  })

  describe('#dispose', () => {
    test('(eventually) disposes of the queue and all items inside it', async () => {
      const obj1 = { disposed: false }
      const obj2 = { disposed: false }
      const obj3 = { disposed: false }
      const obj4 = { disposed: false }
      const objs = [obj1, obj2, obj3, obj4]

      const p = new Pool({
        create: () => objs.shift() as { disposed: boolean },
        dispose: o => { o.item.disposed = true },
        max: 2
      })
      const item1 = await p.acquire()

      const item2 = await p.acquire()

      const item3Promise = p.acquire()

      const hasDisposed = p.dispose()
      expect(p.disposing).not.toBeUndefined()

      await new Promise(resolve => setTimeout(resolve, 2))
      item1.release()
      item2.release()

      const item3 = await item3Promise
      item3.release()

      await expect(p.acquire()).rejects.toThrow()

      await expect(hasDisposed).resolves.toBeUndefined()
      expect(objs).toHaveLength(2)

      expect(obj1.disposed).toEqual(true)
      expect(obj2.disposed).toEqual(true)
      expect(obj3.disposed).toEqual(false)
      expect(obj3.disposed).toEqual(false)
    })


    test('can dispose an empty pool', async () => {
      const p = new Pool({
        create: () => { throw new Error('should never create') },
        max: 1
      })

      await p.dispose()
    })

    test('prevents further acquisitions', async () => {
      const p = new Pool({
        create: () => { throw new Error('should never create') },
        max: 1
      })

      const dispose = p.dispose()
      await expect(p.acquire()).rejects.toThrow()
      expect(p.disposing).toBeUndefined()
      expect(p.disposed).toEqual(true)
      await expect(dispose).resolves.toBeUndefined()
    })

    test('can cancel pending waiting acquisitions', async () => {
      const p = new Pool({
        create: () => 0,
        max: 1
      })

      const item = await p.acquire()
      const item1Promise = p.acquire()
      const item2Promise = p.acquire()
      const item3Promise = p.acquire()

      const dispose = p.dispose()
      item.release()

      const item1 = await item1Promise
      p.dispose(true)
      item1.release()

      await expect(item2Promise).rejects.toThrowError(PoolDisposingError)
      await expect(item3Promise).rejects.toThrowError(PoolDisposingError)
      await expect(dispose).resolves.toBeUndefined()
    })
  })
})
