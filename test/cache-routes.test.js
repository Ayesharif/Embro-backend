import test, { before, after, beforeEach, mock } from 'node:test'
import assert from 'node:assert/strict'
import http from 'node:http'
import mongoose from 'mongoose'
import { createFakeRedis } from './helpers/fakeRedis.js'

process.env.NODE_ENV = 'test'
process.env.LOG_LEVEL = 'error'
process.env.JWT_ACCESS_SECRET = 'x'.repeat(48)
process.env.REDIS_URL = 'redis://fake:6379'

// Real app, real routes and middleware. Only the database layer is replaced with counted stubs.
const { default: app } = await import('../src/app.js')
const { connectRedis } = await import('../src/cache/redisClient.js')
const { drainWrites, resetCacheStats } = await import('../src/cache/cache.js')
const { default: Product } = await import('../src/models/Product.js')
const { default: Category } = await import('../src/models/Category.js')
const { default: Review } = await import('../src/models/Review.js')
const { default: User } = await import('../src/models/User.js')
const { signAccessToken } = await import('../src/middleware/auth.js')

const fake = createFakeRedis()
let server
let base
const dbCalls = { productCount: 0, productFind: 0, productFindOne: 0, categoryFind: 0, reviewFind: 0 }
let mine = null
let categoryCreateFails = false

// A query object that can be chained (.sort().skip()...) and awaited.
const chain = (result) => {
  const query = { sort: () => query, skip: () => query, limit: () => query, populate: () => query, select: () => query, then: (resolve, reject) => Promise.resolve(result).then(resolve, reject) }
  return query
}

const productDoc = async () => {
  const doc = new Product({
    name: 'Yarn', slug: 'yarn', description: 'Soft yarn', category: new mongoose.Types.ObjectId(), status: 'published',
    variants: [{ color: 'Red', size: 'S', sellingAmount: 5000, costAmount: 2000, discountPercent: 20, stock: 4 }],
  })
  await doc.validate()
  return doc
}

before(async () => {
  await connectRedis({ createClient: () => fake.client })
  await new Promise((resolve) => setImmediate(resolve))
  const doc = await productDoc()
  mock.method(Product, 'countDocuments', async () => { dbCalls.productCount += 1; return 1 })
  mock.method(Product, 'find', () => { dbCalls.productFind += 1; return chain([doc]) })
  mock.method(Product, 'findOne', (filter) => { dbCalls.productFindOne += 1; return chain(filter.slug === 'missing' ? null : doc) })
  mock.method(Category, 'find', () => { dbCalls.categoryFind += 1; return chain([{ id: 'c1', name: 'Yarn', slug: 'yarn', description: '', image: undefined }]) })
  mock.method(Category, 'create', async (input) => { if (categoryCreateFails) throw new Error('write failed'); return { id: 'c2', ...input } })
  mock.method(Review, 'find', () => { dbCalls.reviewFind += 1; return chain([]) })
  mock.method(Review, 'findOne', () => chain(mine))
  mock.method(User, 'findById', async (id) => ({ id, _id: id, role: id === 'admin-id' ? 'admin' : 'customer', status: 'active' }))

  server = http.createServer(app)
  await new Promise((resolve) => server.listen(0, resolve))
  base = `http://127.0.0.1:${server.address().port}`
})
after(async () => {
  mock.restoreAll()
  await new Promise((resolve) => server.close(resolve))
})
beforeEach(async () => {
  await drainWrites()
  fake.store.clear()
  fake.state.down = false
  fake.client.emit('ready')
  resetCacheStats()
  Object.keys(dbCalls).forEach((key) => { dbCalls[key] = 0 })
  mine = null
  categoryCreateFails = false
})

const adminToken = signAccessToken({ id: 'admin-id', role: 'admin' })
const customerToken = signAccessToken({ id: 'customer-id', role: 'customer' })
const call = async (path, { method = 'GET', token, body } = {}) => {
  const response = await fetch(base + path, { method, headers: { 'Content-Type': 'application/json', ...(token ? { Authorization: `Bearer ${token}` } : {}) }, body: body ? JSON.stringify(body) : undefined })
  const json = response.status === 204 ? null : await response.json()
  await drainWrites()
  return { status: response.status, json, cache: response.headers.get('x-cache') }
}

test('product list: second identical request does not touch the database; response format is unchanged', async () => {
  const first = await call('/api/v1/products?sort=price_asc&page=1')
  const second = await call('/api/v1/products?page=1&sort=price_asc')
  assert.equal(first.cache, 'MISS')
  assert.equal(second.cache, 'HIT')
  assert.equal(dbCalls.productCount, 1)
  assert.equal(dbCalls.productFind, 1)
  assert.deepEqual(second.json, first.json)
  assert.deepEqual(Object.keys(first.json).sort(), ['data', 'pagination'])
  assert.equal(first.json.data[0].finalAmount, 4000)
  assert.ok(!JSON.stringify(first.json).includes('costAmount')) // purchasing cost never leaves the server
  assert.equal((await call('/api/v1/products?page=2')).cache, 'MISS')
})

test('invalid query parameters are rejected and never cached', async () => {
  assert.equal((await call('/api/v1/products?limit=9999')).status, 400)
  assert.equal((await call('/api/v1/products?limit=9999')).cache, null)
  assert.equal(fake.keys().filter((key) => !key.includes(':ns:')).length, 0)
})

test('product detail: cached on success, 404s are not cached', async () => {
  assert.equal((await call('/api/v1/products/yarn')).cache, 'MISS')
  assert.equal((await call('/api/v1/products/YARN')).cache, 'HIT')
  assert.equal(dbCalls.productFindOne, 1)
  assert.equal((await call('/api/v1/products/missing')).status, 404)
  assert.equal((await call('/api/v1/products/missing')).status, 404)
  assert.equal(dbCalls.productFindOne, 3)
})

test('a successful write invalidates the cache; a failed write does not', async () => {
  await call('/api/v1/categories')
  assert.equal((await call('/api/v1/categories')).cache, 'HIT')

  categoryCreateFails = true
  const failed = await call('/api/v1/admin/categories', { method: 'POST', token: adminToken, body: { name: 'Hats' } })
  assert.equal(failed.status, 500)
  assert.equal((await call('/api/v1/categories')).cache, 'HIT') // nothing changed, so nothing was invalidated

  categoryCreateFails = false
  const created = await call('/api/v1/admin/categories', { method: 'POST', token: adminToken, body: { name: 'Hats' } })
  assert.equal(created.status, 201)
  assert.equal((await call('/api/v1/categories')).cache, 'MISS') // refreshed after the real change
  assert.equal(dbCalls.categoryFind, 2)
})

test('a category change also refreshes product listings that embed the category', async () => {
  await call('/api/v1/products')
  assert.equal((await call('/api/v1/products')).cache, 'HIT')
  await call('/api/v1/admin/categories', { method: 'POST', token: adminToken, body: { name: 'Beads' } })
  assert.equal((await call('/api/v1/products')).cache, 'MISS')
})

test('protected admin data: auth and role checks run before the cache, so cached bodies cannot be reached without them', async () => {
  assert.equal((await call('/api/v1/admin/dashboard')).status, 401)
  const customer = await call('/api/v1/admin/dashboard', { token: customerToken })
  assert.equal(customer.status, 403)
  assert.equal(customer.cache, null)
  assert.equal((await call('/api/v1/admin/accounts', { token: customerToken })).status, 403)
  assert.equal((await call('/api/v1/admin/cache', { token: customerToken })).status, 403)
})

test('guard: only the intended read-only endpoints use the response cache', async () => {
  // If someone adds cacheResponse() to an auth, cart, order, payment, checkout-quote, address or
  // wishlist route, this fails and forces a conscious decision (those return private or transactional data).
  const { readdirSync, readFileSync, statSync } = await import('node:fs')
  const { join, relative } = await import('node:path')
  const { fileURLToPath } = await import('node:url')
  const root = fileURLToPath(new URL('../src', import.meta.url))
  const files = []
  const walk = (dir) => readdirSync(dir).forEach((name) => { const path = join(dir, name); if (statSync(path).isDirectory()) walk(path); else if (path.endsWith('.js')) files.push(path) })
  walk(root)
  const users = files.filter((file) => /cacheResponse\(/.test(readFileSync(file, 'utf8')) && !file.endsWith('middleware.js')).map((file) => relative(root, file).replaceAll('\\', '/')).sort()
  assert.deepEqual(users, [
    'routes/admin/accounts.js', 'routes/admin/content.js', 'routes/categories.js', 'routes/checkout.js',
    'routes/products.js', 'routes/reviews.js', 'routes/settings.js',
  ])
  // ...and within checkout.js / reviews.js only the public, non-personal endpoints are wrapped.
  const checkout = readFileSync(join(root, 'routes/checkout.js'), 'utf8')
  assert.match(checkout, /router\.get\('\/shipping\/methods', cacheResponse/)
  assert.match(checkout, /router\.get\('\/checkout\/options', cacheResponse/)
  assert.doesNotMatch(checkout, /checkout\/quote', cacheResponse|checkout\/quote', requireAuth, cacheResponse/)
  assert.doesNotMatch(readFileSync(join(root, 'routes/reviews.js'), 'utf8'), /eligible', requireAuth, cacheResponse/)
})

test('product reviews: the shared list is cached, "mine" is always read fresh per user', async () => {
  const id = 'a'.repeat(24)
  const anonymous = await call(`/api/v1/products/${id}/reviews`)
  assert.equal(anonymous.json.mine, null)
  mine = { status: 'pending', rating: 5 }
  const signedIn = await call(`/api/v1/products/${id}/reviews`, { token: customerToken })
  assert.deepEqual(signedIn.json.mine, { status: 'pending', rating: 5 })
  mine = { status: 'approved', rating: 5 }
  const later = await call(`/api/v1/products/${id}/reviews`, { token: customerToken })
  assert.equal(later.json.mine.status, 'approved')
  assert.equal(dbCalls.reviewFind, 1) // the list came from cache every time
  const other = await call(`/api/v1/products/${id}/reviews`) // another visitor must not see that user's review
  assert.equal(other.json.mine, null)
})

test('Redis down: public endpoints keep working from the database', async () => {
  fake.state.down = true
  const first = await call('/api/v1/products')
  const second = await call('/api/v1/products')
  assert.equal(first.status, 200)
  assert.equal(second.status, 200)
  assert.equal(second.cache, 'BYPASS')
  assert.equal(dbCalls.productFind, 2)
  // Auth is still enforced while Redis is down.
  assert.equal((await call('/api/v1/admin/dashboard')).status, 401)
  assert.equal((await call('/api/v1/admin/dashboard', { token: customerToken })).status, 403)
})

test('admin can inspect stats and purge the cache; customers cannot', async () => {
  await call('/api/v1/products')
  await call('/api/v1/products')
  const stats = await call('/api/v1/admin/cache', { token: adminToken })
  assert.equal(stats.status, 200)
  assert.equal(stats.json.hits, 1)
  assert.equal(stats.json.connected, true)
  assert.equal((await call('/api/v1/admin/cache/purge', { method: 'POST', token: customerToken })).status, 403)
  assert.equal((await call('/api/v1/admin/cache/purge', { method: 'POST', token: adminToken })).status, 200)
  assert.equal((await call('/api/v1/products')).cache, 'MISS')
})
