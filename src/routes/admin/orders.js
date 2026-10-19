import { Router } from 'express'
import Order from '../../models/Order.js'
import Product from '../../models/Product.js'
import InventoryMovement from '../../models/InventoryMovement.js'
import Refund from '../../models/Refund.js'
import Shipment from '../../models/Shipment.js'
import { ROLE_GROUPS, requireRole } from '../../middleware/auth.js'
import { asyncHandler, HttpError } from '../../utils/httpError.js'
import { escapeRegex } from '../../utils/text.js'
import { parse, parseId, v } from '../../utils/validation.js'
import { onOrderChange, onStockChange } from '../../cache/namespaces.js'
import { formatMoney } from '../../config/currencies.js'
import { restockOrder, markDelivered } from '../../services/orders.js'
import { stripe } from '../payments.js'

const router = Router()
const STATUSES = ['pending', 'paid', 'processing', 'shipped', 'delivered', 'cancelled', 'refunded']

router.get('/orders', requireRole(...ROLE_GROUPS.orders), asyncHandler(async (request, response) => {
  const { status, q, page = 1, limit = 50 } = parse({
    status: v.optional(v.oneOf(STATUSES)),
    q: v.optional(v.string({ min: 1, max: 40 })),
    page: v.optional(v.integer({ min: 1, max: 10000, coerce: true })),
    limit: v.optional(v.integer({ min: 1, max: 100, coerce: true })),
  }, request.query)
  const filter = {}
  if (status) filter.status = status
  if (q) filter.number = { $regex: escapeRegex(q.toUpperCase()) }
  const [total, orders] = await Promise.all([
    Order.countDocuments(filter),
    Order.find(filter).populate('user', 'name email').sort({ createdAt: -1 }).skip((page - 1) * limit).limit(limit),
  ])
  response.json({ data: orders, pagination: { page, limit, total, totalPages: Math.max(1, Math.ceil(total / limit)) } })
}))

router.get('/orders/:id', requireRole(...ROLE_GROUPS.orders), asyncHandler(async (request, response) => {
  const id = parseId(request.params.id, 'order id')
  const order = await Order.findById(id).populate('user', 'name email')
  if (!order) throw new HttpError(404, 'ORDER_NOT_FOUND', 'Order not found.')
  const [shipments, refunds] = await Promise.all([Shipment.find({ order: id }).sort({ createdAt: 1 }), Refund.find({ order: id }).sort({ createdAt: 1 })])
  response.json({ order, shipments, refunds })
}))

// Fulfilment moves forward only. "paid"/"refunded" are driven by payments and refunds, never set by hand.
// Cash-on-delivery orders can additionally be cancelled while unpaid and unshipped (stock is returned);
// paid online orders must be refunded instead.
const RANK = { pending: 0, paid: 1, processing: 2, shipped: 3, delivered: 4 }

router.patch('/orders/:id', requireRole(...ROLE_GROUPS.fulfillment), asyncHandler(async (request, response) => {
  const { status } = parse({ status: v.oneOf(['processing', 'shipped', 'delivered', 'cancelled']) }, request.body)
  const order = await Order.findById(parseId(request.params.id, 'order id'))
  if (!order) throw new HttpError(404, 'ORDER_NOT_FOUND', 'Order not found.')
  const isCod = order.paymentMethod === 'cod'

  if (status === 'cancelled') {
    if (!isCod || order.paymentStatus !== 'pending' || RANK[order.status] === undefined || RANK[order.status] >= RANK.shipped) {
      throw new HttpError(409, 'NOT_CANCELLABLE', 'Only unpaid cash-on-delivery orders that have not shipped can be cancelled here. Refund paid orders instead.')
    }
    order.status = 'cancelled'
    await restockOrder(order, request.user._id, 'cancelled order')
  } else {
    if (RANK[order.status] === undefined || RANK[status] <= RANK[order.status]) {
      throw new HttpError(409, 'INVALID_TRANSITION', `An order that is ${order.status} cannot be moved to ${status}.`)
    }
    if (order.status === 'pending' && !isCod) throw new HttpError(409, 'INVALID_TRANSITION', 'This order is not paid yet.')
    if (status === 'delivered') markDelivered(order)
    else order.status = status
  }
  await order.save()
  await onOrderChange()
  response.json({ order })
}))

router.post('/orders/:id/shipments', requireRole(...ROLE_GROUPS.fulfillment), asyncHandler(async (request, response) => {
  const id = parseId(request.params.id, 'order id')
  const input = parse({ carrier: v.string({ min: 2, max: 80 }), trackingNumber: v.string({ min: 3, max: 120 }) }, request.body)
  const order = await Order.findOneAndUpdate({ _id: id, status: { $in: ['pending', 'paid', 'processing', 'shipped'] } }, { $set: { status: 'shipped' } }, { new: true })
  if (!order) throw new HttpError(404, 'ORDER_NOT_UPDATABLE', 'Order not found, or it cannot be shipped in its current state.')
  const shipment = await Shipment.create({ ...input, order: id, status: 'shipped', shippedAt: new Date() })
  await onOrderChange()
  response.status(201).json({ shipment, order })
}))

router.patch('/shipments/:id', requireRole(...ROLE_GROUPS.fulfillment), asyncHandler(async (request, response) => {
  const { status } = parse({ status: v.oneOf(['in_transit', 'delivered', 'returned']) }, request.body)
  const shipment = await Shipment.findByIdAndUpdate(parseId(request.params.id, 'shipment id'), { $set: { status, ...(status === 'delivered' ? { deliveredAt: new Date() } : {}) } }, { new: true })
  if (!shipment) throw new HttpError(404, 'SHIPMENT_NOT_FOUND', 'Shipment not found.')
  if (status === 'delivered') {
    const order = await Order.findOne({ _id: shipment.order, status: 'shipped' })
    if (order) {
      markDelivered(order)
      await order.save()
      await onOrderChange()
    }
  }
  response.json({ shipment })
}))

router.post('/orders/:id/refunds', requireRole(...ROLE_GROUPS.finance), asyncHandler(async (request, response) => {
  if (!stripe) throw new HttpError(503, 'STRIPE_NOT_CONFIGURED', 'Payments are not configured.')
  const id = parseId(request.params.id, 'order id')
  const input = parse({
    amount: v.optional(v.integer({ min: 1, max: 100_000_000 })),
    reason: v.string({ min: 3, max: 500 }),
    restock: v.optional(v.boolean()),
  }, request.body)
  const order = await Order.findById(id)
  if (!order || !order.paymentIntentId) throw new HttpError(404, 'ORDER_NOT_FOUND', 'Order not found, or it was not paid online (cash-on-delivery orders have nothing to refund).')
  const remaining = order.totalAmount - order.refundedAmount
  const amount = input.amount ?? remaining
  if (amount < 1 || amount > remaining) throw new HttpError(400, 'INVALID_REFUND_AMOUNT', `You can refund up to ${formatMoney(remaining, order.currency)}.`)

  const refund = await Refund.create({ order: id, amount, reason: input.reason, createdBy: request.user._id })
  try {
    const providerRefund = await stripe.refunds.create(
      { payment_intent: order.paymentIntentId, amount, reason: 'requested_by_customer', metadata: { orderNumber: order.number } },
      { idempotencyKey: `refund-${refund.id}` },
    )
    refund.status = 'processed'
    refund.providerRefundId = providerRefund.id
  } catch (error) {
    refund.status = 'failed'
    await refund.save()
    throw error
  }

  order.refundedAmount += amount
  const full = order.refundedAmount >= order.totalAmount
  order.paymentStatus = full ? 'refunded' : 'partially_refunded'
  if (full) order.status = 'refunded'
  await order.save()

  if (input.restock && full) {
    for (const item of order.items) {
      const filter = item.variantId ? { _id: item.product, 'variants._id': item.variantId } : { _id: item.product }
      const update = item.variantId ? { $inc: { 'variants.$.stock': item.quantity } } : { $inc: { stock: item.quantity } }
      await Product.updateOne(filter, update)
      await InventoryMovement.create({ product: item.product, variantId: item.variantId, quantityDelta: item.quantity, reason: 'refund restock', reference: order.number, actor: request.user._id })
    }
    refund.restocked = true
  }
  await refund.save()
  await onOrderChange()
  if (refund.restocked) await onStockChange()
  response.status(201).json({ refund, order })
}))

export default router
