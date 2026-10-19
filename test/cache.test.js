import test, { before, after, beforeEach } from 'node:test'
import assert from 'node:assert/strict'
import http from 'node:http'
import express from 'express'
import { createFakeRedis } from './helpers/fakeRedis.js'

process.env.NODE_ENV = 'test'
process.env.LOG_LEVEL = 'error'
process.env.REDIS_URL = 'redis://fake:6379'
process.env.REDIS_COMMAND_TIMEOUT_MS = '60'
process.env.CACHE_MAX_VALUE_BYTES = '2000'

const { connectRedis } = await import('../src/cache/redisClient.js')
const { cached, drainWrites, getCacheStats, invalidate, resetCacheStats } = await import('../src/cache/cache.js')
const { cacheResponse } = await import('../src/cache/middleware.js')
const { NS } = await import('../src/cache/namespaces.js')

const fake = createFakeRedis()
let server
let base
let handlerCalls = 0
let handler = async (request, response) => response.json({ page: request.query.page || '1', n: ++handlerCalls })

before(async () => {
  assert.equal(await connectRedis({ createClient: () => fake.client }), true)
  await new Promise((resolve) => setImmediate(resolve)) // let the fake emit "ready"

  const app = express()
  const stubAuth = (request, response, next) => {
    const user = request.get('x-user')
    if (!user) return response.status(401).json({ error: 'unauthenticated' })
    request.user = { id: user }
    return next()
  }
  const run = (request, response, next) => handler(request, response).catch(next)

  app.get('/list', cacheResponse({ name: 'list', namespaces: [NS.PRODUCTS], ttl: 60, allowedQuery: ['page', 'sort'] }), run)
  app.get('/other', cacheResponse({ name: 'other', namespaces: [NS.CATEGORIES], ttl: 60 }), run)
  app.get('/staff', stubAuth, cacheResponse({ name: 'staff', namespaces: [NS.ADMIN_STATS], ttl: 60, scope: 'staff' }), run)
  app.get('/mine', stubAuth, cacheResponse({ name: 'mine', namespaces: [NS.ADMIN_STATS], ttl: 60, scope: 'user' }), (request, response) => response.json({ owner: request.user.id, n: ++handlerCalls }))
  app.get('/staff-misordered', cacheResponse({ name: 'misordered', namespaces: [NS.ADMIN_STATS], ttl: 60, scope: 'staff' }), run)
  app.use((error, request, response, next) => {
    response.status(500).json({ error: 'boom' })
  })
  server = http.createServer(app)
  await new Promise((resolve) => server.listen(0, resolve))
  base = `http://127.0.0.1:${server.address().port}`
})
after(() => new Promise((resolve) => server.close(resolve)))

beforeEach(async () => {
  await drainWrites()
  fake.store.clear()
  fake.state.down = false
  fake.state.delayMs = 0
  fake.client.emit('ready')
  fake.resetCalls()
  resetCacheStats()
  handlerCalls = 0
  handler = async (request, response) => response.json({ page: request.query.page || '1', n: ++handlerCalls })
})

const get = async (path, headers = {}) => {
  const response = await fetch(base + path, { headers })
  const body = await response.json()
  await drainWrites()
  return { status: response.status, body, cache: response.headers.get('x-cache'), type: response.headers.get('content-type') }
}

test('1+2. first request misses and fills the cache, second is served without running the handler', async () => {
  const first = await get('/list')
  assert.equal(first.cache, 'MISS')
  assert.equal(first.body.n, 1)
  const second = await get('/list')
  assert.equal(second.cache, 'HIT')
  assert.deepEqual(second.body, first.body) // same response shape and content
  assert.match(second.type, /application\/json/)
  assert.equal(handlerCalls, 1)
  const stats = getCacheStats()
  assert.equal(stats.hits, 1)
  assert.equal(stats.misses, 1)
  assert.equal(stats.hitRatio, 0.5)
})

test('3. entries expire after their TTL and are fetched again', async () => {
  await get('/list')
  fake.advance(30_000)
  assert.equal((await get('/list')).cache, 'HIT')
  fake.advance(40_000) // 70s > 60s TTL (+10% jitter at most = 66s)
  const after = await get('/list')
  assert.equal(after.cache, 'MISS')
  assert.equal(handlerCalls, 2)
})

test('4. invalidating a namespace refreshes only the entries that depend on it', async () => {
  await get('/list')
  await get('/other')
  await invalidate([NS.PRODUCTS])
  assert.equal((await get('/list')).cache, 'MISS')
  assert.equal((await get('/other')).cache, 'HIT')
  assert.equal(handlerCalls, 3)
})

test('5. different pagination/sort give different entries; irrelevant params and param order do not', async () => {
  await get('/list?page=1&sort=price')
  assert.equal((await get('/list?page=2&sort=price')).cache, 'MISS')
  assert.equal((await get('/list?page=1&sort=name')).cache, 'MISS')
  assert.equal((await get('/list?sort=price&page=1')).cache, 'HIT')            // order doesn't matter
  assert.equal((await get('/list?page=1&sort=price&cachebuster=123')).cache, 'HIT') // unknown params can't create new keys
  const before = fake.keys().length
  for (let index = 0; index < 20; index += 1) await get(`/list?page=1&sort=price&junk=${index}`)
  assert.equal(fake.keys().length, before) // no key explosion from attacker-controlled params
})

test('6a. staff-scoped data is never served to an unauthenticated request', async () => {
  assert.equal((await get('/staff', { 'x-user': 'admin-1' })).cache, 'MISS')
  assert.equal((await get('/staff', { 'x-user': 'admin-1' })).cache, 'HIT')
  const anonymous = await get('/staff')
  assert.equal(anonymous.status, 401) // auth middleware runs before the cache
  assert.equal(anonymous.cache, null)
})

test('6b. a staff-scoped route that lost its auth middleware still refuses to cache or serve', async () => {
  const first = await get('/staff-misordered')
  const second = await get('/staff-misordered')
  assert.notEqual(first.cache, 'HIT')
  assert.notEqual(second.cache, 'HIT')
  assert.equal(handlerCalls, 2)
})

test('6c. user-scoped entries are isolated per user', async () => {
  const alice = await get('/mine', { 'x-user': 'alice' })
  const bob = await get('/mine', { 'x-user': 'bob' })
  assert.equal(alice.body.owner, 'alice')
  assert.equal(bob.body.owner, 'bob')
  assert.equal(bob.cache, 'MISS') // bob never receives alice's cached body
  const aliceAgain = await get('/mine', { 'x-user': 'alice' })
  assert.equal(aliceAgain.cache, 'HIT')
  assert.equal(aliceAgain.body.owner, 'alice')
})

test('7a. Redis erroring: requests still succeed from the handler', async () => {
  fake.state.down = true
  const first = await get('/list')
  const second = await get('/list')
  assert.equal(first.status, 200)
  assert.equal(second.status, 200)
  assert.equal(first.cache, 'BYPASS')
  assert.equal(handlerCalls, 2)
  assert.ok(getCacheStats().errors > 0)
  fake.state.down = false
  assert.equal((await get('/list')).cache, 'MISS') // caching resumes once Redis is back
  assert.equal((await get('/list')).cache, 'HIT')
})

test('7b. Redis disconnected (reconnecting): requests skip Redis entirely and stay fast', async () => {
  fake.client.emit('reconnecting')
  fake.resetCalls()
  const response = await get('/list')
  assert.equal(response.status, 200)
  assert.equal(response.cache, 'BYPASS')
  assert.deepEqual(fake.state.calls, { get: 0, set: 0, incr: 0, mGet: 0 })
})

test('7c. a slow Redis is cut off by the command timeout instead of stalling the request', async () => {
  fake.state.delayMs = 400
  const started = Date.now()
  const response = await get('/list')
  assert.equal(response.status, 200)
  assert.ok(Date.now() - started < 300, 'request should not wait for the slow Redis')
})

test('8. failed or error responses are never cached', async () => {
  handler = async () => { throw new Error('database exploded') }
  assert.equal((await get('/list')).status, 500)
  assert.equal((await get('/list')).status, 500)
  handler = async (request, response) => response.json({ ok: true, n: ++handlerCalls })
  const recovered = await get('/list')
  assert.equal(recovered.status, 200)
  assert.equal(recovered.cache, 'MISS') // the earlier 500s left nothing behind
  assert.equal((await get('/list')).cache, 'HIT')

  handler = async (request, response) => response.status(404).json({ error: 'not found' })
  assert.equal((await get('/other')).status, 404)
  assert.equal((await get('/other')).cache, null)
})

test('9. concurrent identical misses run the expensive query once', async () => {
  handler = async (request, response) => {
    await new Promise((resolve) => setTimeout(resolve, 80))
    response.json({ n: ++handlerCalls })
  }
  const results = await Promise.all(Array.from({ length: 12 }, () => get('/list')))
  assert.equal(handlerCalls, 1)
  assert.ok(results.every((result) => result.status === 200 && result.body.n === 1))
  assert.ok(getCacheStats().coalesced >= 1)
})

test('10. an invalidation that happens while Redis is down is applied when it reconnects', async () => {
  await get('/list')
  assert.equal((await get('/list')).cache, 'HIT')
  fake.state.down = true
  await invalidate([NS.PRODUCTS]) // DB changed, but Redis can't be told
  assert.equal(getCacheStats().invalidationFailures, 1)
  fake.state.down = false
  fake.client.emit('ready') // reconnect
  await new Promise((resolve) => setTimeout(resolve, 30))
  assert.equal((await get('/list')).cache, 'MISS') // the stale entry is not served
})

test('11. losing a version key (eviction/restart) can never resurrect stale entries', async () => {
  await get('/list')
  for (const key of [...fake.store.keys()]) if (key.includes(':ns:')) fake.store.delete(key)
  await new Promise((resolve) => setTimeout(resolve, 2)) // new version token differs from the old one
  assert.equal((await get('/list')).cache, 'MISS')
})

test('12. oversized responses are not stored', async () => {
  handler = async (request, response) => response.json({ blob: 'x'.repeat(5000), n: ++handlerCalls })
  await get('/list')
  assert.equal((await get('/list')).cache, 'MISS')
  assert.equal(handlerCalls, 2)
})

test('13. cached() helper: loader runs once, results round-trip, and invalidation applies', async () => {
  let loads = 0
  const spec = { name: 'helper', namespaces: [NS.REVIEWS], ttl: 60, fingerprint: 'product-1' }
  const loader = async () => ({ list: [1, 2, 3], loads: ++loads })
  assert.deepEqual(await cached(spec, loader), { list: [1, 2, 3], loads: 1 })
  await drainWrites()
  assert.deepEqual(await cached(spec, loader), { list: [1, 2, 3], loads: 1 })
  assert.equal(loads, 1)
  await invalidate([NS.REVIEWS])
  assert.equal((await cached(spec, loader)).loads, 2)
  await assert.rejects(cached({ ...spec, fingerprint: 'other' }, async () => { throw new Error('db down') }), /db down/)
})

test('14. logs and stats never contain cached values', async () => {
  await get('/list')
  await get('/list')
  const text = JSON.stringify(getCacheStats())
  assert.ok(!text.includes('"page"'))
})
