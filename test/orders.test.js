import test from 'node:test'
import assert from 'node:assert/strict'

process.env.NODE_ENV = 'test'
process.env.JWT_ACCESS_SECRET = 'x'.repeat(48)

await import('../src/config/mongoose.js')
const { default: Order } = await import('../src/models/Order.js')
const { markDelivered } = await import('../src/services/orders.js')

test('deliveryStatus is derived from the order status', () => {
  const status = (value) => new Order({ status: value }).deliveryStatus
  assert.equal(status('pending'), 'pending')
  assert.equal(status('paid'), 'pending')
  assert.equal(status('processing'), 'processing')
  assert.equal(status('shipped'), 'shipped')
  assert.equal(status('delivered'), 'delivered')
  assert.equal(status('cancelled'), 'cancelled')
  assert.equal(status('refunded'), 'cancelled')
})

test('delivering a cash-on-delivery order records the cash as paid', () => {
  const order = new Order({ status: 'shipped', paymentMethod: 'cod', paymentStatus: 'pending' })
  markDelivered(order)
  assert.equal(order.status, 'delivered')
  assert.equal(order.paymentStatus, 'paid')
  assert.ok(order.paidAt && order.deliveredAt)
})

test('delivering an online order does not touch its payment status', () => {
  const order = new Order({ status: 'shipped', paymentMethod: 'online', paymentStatus: 'paid' })
  markDelivered(order)
  assert.equal(order.paymentStatus, 'paid')
})

test('orders serialise with a string id and the delivery status', () => {
  const json = new Order({ status: 'shipped', paymentMethod: 'cod' }).toJSON()
  assert.equal(typeof json.id, 'string')
  assert.equal(json.deliveryStatus, 'shipped')
  assert.equal(json.__v, undefined)
})
