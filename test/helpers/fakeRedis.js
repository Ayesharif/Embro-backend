import { EventEmitter } from 'node:events'

// In-memory stand-in for the `redis` client (get/set/incr/mGet + events) with a virtual clock and
// failure injection. It lets the tests exercise the caching logic without a Redis server.
// It does NOT prove behaviour of the real `redis` package or server - see docs/CACHING.md.
export function createFakeRedis() {
  const store = new Map()
  const state = { clock: 0, down: false, delayMs: 0, calls: { get: 0, set: 0, incr: 0, mGet: 0 } }
  const client = new EventEmitter()

  const alive = (key) => {
    const entry = store.get(key)
    if (!entry) return null
    if (entry.expiresAt !== null && entry.expiresAt <= state.clock) {
      store.delete(key)
      return null
    }
    return entry
  }
  const gate = async () => {
    if (state.delayMs) await new Promise((resolve) => setTimeout(resolve, state.delayMs))
    if (state.down) throw new Error('connect ECONNREFUSED 127.0.0.1:6379')
  }

  Object.assign(client, {
    async connect() { queueMicrotask(() => client.emit('ready')) },
    async get(key) { state.calls.get += 1; await gate(); return alive(key)?.value ?? null },
    async mGet(keys) { state.calls.mGet += 1; await gate(); return keys.map((key) => alive(key)?.value ?? null) },
    async set(key, value, options = {}) {
      state.calls.set += 1
      await gate()
      if (options.NX && alive(key)) return null
      store.set(key, { value: String(value), expiresAt: options.EX ? state.clock + options.EX * 1000 : null })
      return 'OK'
    },
    async incr(key) {
      state.calls.incr += 1
      await gate()
      const next = Number(alive(key)?.value ?? 0) + 1
      store.set(key, { value: String(next), expiresAt: null })
      return next
    },
    async quit() {},
    async disconnect() {},
  })

  return {
    client,
    store,
    state,
    advance: (ms) => { state.clock += ms },
    keys: () => [...store.keys()].filter((key) => alive(key)),
    resetCalls: () => { state.calls = { get: 0, set: 0, incr: 0, mGet: 0 } },
  }
}
