import { Pool, TimeoutError } from './index'

test('it returns the value the inner function returns', async () => {
  const p = new Pool({
    factory: () => {},
    max: 1
  })

  const val = await p.acquire().then(item => {
    item.release()
    return 'val'
  })
  expect(val).toEqual('val')
})

describe('verify', () => {
  test('supports synchronous verification', async () => {
    let i = 0
    let j = 0

    const p = new Pool({
      factory: () => i++,
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
      factory: () => i++,
      max: 1,
      verify: () => new Promise(resolve => process.nextTick(() => resolve(j++ % 3 < 2)))
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

  test('onDispose is called for items that fail validation', async () => {
    let i = 0
    let j = 0
    const onDispose = jest.fn()
    const p = new Pool({
      factory: () => i++,
      max: 1,
      verify: () => j++ % 2 === 0,
      onDispose
    })

    const item1 = await p.acquire()
    item1.release()

    expect(onDispose).not.toHaveBeenCalled()

    const item2 = await p.acquire()
    expect(onDispose).toHaveBeenCalled()
    item2.release()

    expect(onDispose).toHaveBeenCalledTimes(1)
  })

  describe('acquire ordering', () => {
    test('acquire order is not tied to verification order, is fifo', async () => {
      let timeout = 30
      let i = 0
      const p = new Pool({
        factory: () => i++,
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
  })
})

test('it resolves in order', async () => {
  const p = new Pool({
    factory: () => {},
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
    factory: () => i++,
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

describe('release', () => {
  test('it throws on double-release', async () => {
    const p = new Pool({
      factory: () => {},
      max: 1
    })
    const item = await p.acquire()
    item.release()
    expect(() => item.release()).toThrow()
  })

  test('it disposes on release if desired', async () => {
    let i = 0
    const p = new Pool({
      factory: () => i++,
      max: 1
    })

    const item1 = await p.acquire()
    const item1Item = item1.item
    item1.release()

    const item2 = await p.acquire()
    expect(item1Item).toEqual(item2.item)
    item2.release(true) // dispose

    const item3 = await p.acquire()
    expect(item1Item).not.toEqual(item3.item)
  })
})

describe('timeouts', () => {
  beforeAll(() => jest.useFakeTimers())
  afterAll(() => jest.useRealTimers())

  test('acquire times out correctly', async () => {
    const p = new Pool({
      factory: () => {},
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
      factory: () => {},
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
      factory: () => {},
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
