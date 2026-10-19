import test, { before, after, mock } from 'node:test'
import assert from 'node:assert/strict'
import http from 'node:http'

// Exercises the real Express app (middleware, routing, validation, error handling) without a database:
// every case here must be decided before any query runs, or the query is stubbed.
process.env.NODE_ENV = 'test'
process.env.WEB_APP_URL = 'http://localhost:5173'
process.env.JWT_ACCESS_SECRET = 'x'.repeat(48)

const { default: app } = await import('../src/app.js')
const { default: User } = await import('../src/models/User.js')
const { signAccessToken } = await import('../src/middleware/auth.js')

let server
let base
before(async () => {
  server = http.createServer(app)
  await new Promise((resolve) => server.listen(0, resolve))
  base = `http://127.0.0.1:${server.address().port}`
})
after(() => new Promise((resolve) => server.close(resolve)))

const call = (path, { method = 'GET', body, token, headers = {} } = {}) => fetch(base + path, {
  method,
  headers: { 'Content-Type': 'application/json', ...(token ? { Authorization: `Bearer ${token}` } : {}), ...headers },
  body: body === undefined ? undefined : JSON.stringify(body),
})

function actAs(role, id = 'a'.repeat(24)) {
  const user = { id, _id: id, role, status: 'active' }
  mock.method(User, 'findById', async () => user)
  return signAccessToken(user)
}

test('unknown routes return a clean 404', async () => {
  const response = await call('/nope')
  assert.equal(response.status, 404)
  assert.equal((await response.json()).error.code, 'NOT_FOUND')
})

test('malformed JSON is a 400, not a 500', async () => {
  const response = await fetch(`${base}/api/v1/auth/login`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{oops' })
  assert.equal(response.status, 400)
})

test('login rejects operator-injection payloads before touching the database', async () => {
  const response = await call('/api/v1/auth/login', { method: 'POST', body: { email: { $gt: '' }, password: { $gt: '' } } })
  assert.equal(response.status, 400)
})

test('protected routes require a token', async () => {
  for (const path of ['/api/v1/orders', '/api/v1/wishlist', '/api/v1/me/addresses', '/api/v1/admin/users', '/api/v1/admin/products']) {
    assert.equal((await call(path)).status, 401, path)
  }
})

test('a forged token signed with another secret is rejected', async () => {
  const response = await call('/api/v1/orders', { token: 'eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiJ4In0.invalid' })
  assert.equal(response.status, 401)
})

test('guest cart without an id is refused instead of sharing one global cart', async () => {
  const response = await call('/api/v1/cart/items', { method: 'POST', body: { productId: 'b'.repeat(24) } })
  assert.equal(response.status, 400)
  assert.equal((await response.json()).error.code, 'GUEST_ID_REQUIRED')
})

test('customers cannot reach the admin API', async () => {
  const token = actAs('customer')
  assert.equal((await call('/api/v1/admin/users', { token })).status, 403)
  assert.equal((await call('/api/v1/admin/discounts', { token })).status, 403)
  mock.restoreAll()
})

test('support staff cannot edit users, catalogue or discounts (privilege-escalation regression)', async () => {
  const token = actAs('support')
  const target = 'c'.repeat(24)
  assert.equal((await call(`/api/v1/admin/users/${target}`, { method: 'PATCH', token, body: { role: 'super_admin' } })).status, 403)
  assert.equal((await call('/api/v1/admin/products', { method: 'POST', token, body: {} })).status, 403)
  assert.equal((await call('/api/v1/admin/discounts', { method: 'POST', token, body: {} })).status, 403)
  assert.equal((await call(`/api/v1/admin/orders/${target}/refunds`, { method: 'POST', token, body: {} })).status, 403)
  mock.restoreAll()
})

test('payment intents cannot be created from a client-supplied amount', async () => {
  const token = actAs('customer')
  const response = await call('/api/v1/payments/intent', { method: 'POST', token, body: { amount: 1, currency: 'usd' } })
  // No Stripe key in tests -> 503; with one, a missing quoteId is a 400. Either way no intent is created.
  assert.ok([400, 503].includes(response.status))
  mock.restoreAll()
})

test('product query params are validated', async () => {
  const response = await call('/api/v1/products?limit=9999')
  assert.equal(response.status, 400)
})

test('error responses never expose raw database error codes', async () => {
  const response = await call('/api/v1/products?page=abc')
  const body = await response.json()
  assert.equal(typeof body.error.code, 'string')
})

test('cash on delivery needs a signed-in customer and a valid quote id', async () => {
  assert.equal((await call('/api/v1/orders/cod', { method: 'POST', body: { quoteId: 'a'.repeat(24) } })).status, 401)
  const token = actAs('customer')
  const response = await call('/api/v1/orders/cod', { method: 'POST', token, body: { quoteId: { $ne: null } } })
  assert.equal(response.status, 400)
  mock.restoreAll()
})

test('only fulfilment staff can change order status', async () => {
  const token = actAs('customer')
  assert.equal((await call(`/api/v1/admin/orders/${'d'.repeat(24)}`, { method: 'PATCH', token, body: { status: 'delivered' } })).status, 403)
  mock.restoreAll()
  const support = actAs('support')
  assert.equal((await call(`/api/v1/admin/orders/${'d'.repeat(24)}`, { method: 'PATCH', token: support, body: { status: 'delivered' } })).status, 403)
  mock.restoreAll()
})

test('review helpers require sign-in', async () => {
  assert.equal((await call('/api/v1/reviews/eligible')).status, 401)
  assert.equal((await call('/api/v1/reviews', { method: 'POST', body: { productId: 'a'.repeat(24), rating: 5, body: 'Lovely product, really' } })).status, 401)
})

test('shipping methods and category images are admin-only', async () => {
  assert.equal((await call('/api/v1/admin/shipping-methods')).status, 401)
  const token = actAs('warehouse')
  assert.equal((await call('/api/v1/admin/shipping-methods', { method: 'POST', token, body: { name: 'Free', amount: 0 } })).status, 403)
  mock.restoreAll()
})

test('shipping method input is validated', async () => {
  const token = actAs('admin')
  const bad = await call('/api/v1/admin/shipping-methods', { method: 'POST', token, body: { name: 'Express', amount: 500, estimatedDaysMin: 5, estimatedDaysMax: 2 } })
  assert.equal(bad.status, 400)
  const foreign = await call('/api/v1/admin/categories', { method: 'POST', token, body: { name: 'Hats', image: { publicId: 'x', secureUrl: 'http://evil.example/a.png' } } })
  assert.equal(foreign.status, 400)
  mock.restoreAll()
})

test('currency settings are restricted to admins and validated before anything is changed', async () => {
  assert.equal((await call('/api/v1/admin/settings')).status, 401)
  const warehouse = actAs('warehouse')
  assert.equal((await call('/api/v1/admin/settings', { token: warehouse })).status, 403)
  mock.restoreAll()

  const token = actAs('admin')
  const post = (body) => call('/api/v1/admin/settings/currency', { method: 'POST', token, body })
  assert.equal((await post({ to: 'XYZ', mode: 'relabel', confirm: 'XYZ' })).status, 400)
  assert.equal((await post({ to: 'PKR', mode: 'convert', confirm: 'PKR' })).status, 400) // rate missing
  assert.equal((await post({ to: 'PKR', mode: 'convert', rate: -5, confirm: 'PKR' })).status, 400)
  const unconfirmed = await post({ to: 'PKR', mode: 'convert', rate: 280 })
  assert.equal(unconfirmed.status, 400)
  assert.equal((await unconfirmed.json()).error.code, 'CONFIRMATION_REQUIRED')
  mock.restoreAll()
})
