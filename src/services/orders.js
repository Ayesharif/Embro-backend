import Cart from '../models/Cart.js'
import CheckoutQuote from '../models/CheckoutQuote.js'
import Discount from '../models/Discount.js'
import InventoryMovement from '../models/InventoryMovement.js'
import Order from '../models/Order.js'
import Product from '../models/Product.js'
import User from '../models/User.js'
import { onOrderChange, onStockChange } from '../cache/namespaces.js'
import { HttpError } from '../utils/httpError.js'
import { orderConfirmationEmail, sendEmail } from '../utils/mailer.js'

// Atomically take stock for every line. A line that cannot be fulfilled is reported instead of
// pushing stock below zero; the order is then flagged so staff can sort it out manually.
async function applyInventory(order) {
  const claimed = await Order.findOneAndUpdate({ _id: order._id, inventoryApplied: { $ne: true } }, { $set: { inventoryApplied: true } })
  if (!claimed) return []
  const shortages = []
  for (const item of order.items) {
    const result = await Product.updateOne(
      { _id: item.product, variants: { $elemMatch: { _id: item.variantId, stock: { $gte: item.quantity } } } },
      { $inc: { 'variants.$.stock': -item.quantity } },
    )
    if (result.modifiedCount) {
      await InventoryMovement.create({ product: item.product, variantId: item.variantId, quantityDelta: -item.quantity, reason: 'order', reference: order.number })
    } else {
      shortages.push(item.productNameSnapshot)
    }
  }
  if (shortages.length) {
    await Order.updateOne({ _id: order._id }, { $set: { requiresAttention: true, notes: `Stock shortage at fulfilment: ${shortages.join(', ')}` } })
  }
  // Stock changed, so cached product pages showing it are now out of date.
  await onStockChange()
  return shortages
}

// Puts a cancelled order's items back on the shelf (only if stock was actually taken).
export async function restockOrder(order, actorId, reason) {
  const claimed = await Order.findOneAndUpdate({ _id: order._id, inventoryApplied: true }, { $set: { inventoryApplied: false } })
  if (!claimed) return
  for (const item of order.items) {
    await Product.updateOne({ _id: item.product, 'variants._id': item.variantId }, { $inc: { 'variants.$.stock': item.quantity } })
    await InventoryMovement.create({ product: item.product, variantId: item.variantId, quantityDelta: item.quantity, reason, reference: order.number, actor: actorId })
  }
  await onStockChange()
}

async function consumeDiscount(code) {
  if (!code) return
  await Discount.updateOne(
    { code, $or: [{ usageLimit: { $exists: false } }, { usageLimit: null }, { $expr: { $lt: ['$usedCount', '$usageLimit'] } }] },
    { $inc: { usedCount: 1 } },
  )
}

// Cash collected by the courier at the door counts as payment received once delivery is confirmed.
export function markDelivered(order) {
  order.status = 'delivered'
  order.deliveredAt = new Date()
  if (order.paymentMethod === 'cod' && order.paymentStatus === 'pending') {
    order.paymentStatus = 'paid'
    order.paidAt = new Date()
  }
}

// Records what each variant cost at the moment of sale, so profit stays correct even if costs change later.
async function itemsWithCost(quote) {
  const products = await Product.find({ _id: { $in: quote.items.map((item) => item.product) } }).select('variants.costAmount')
  return quote.items.map((item) => {
    const variant = products.find((product) => String(product._id) === String(item.product))?.variants.id(item.variantId)
    return { ...item.toObject(), costAmountSnapshot: variant?.costAmount }
  })
}

async function createOrderFromQuote(quote, extra) {
  const order = await Order.create({
    user: quote.user,
    quote: quote._id,
    items: await itemsWithCost(quote),
    addressSnapshot: quote.shippingAddress?.toObject(),
    subtotalAmount: quote.subtotalAmount,
    shippingAmount: quote.shippingAmount,
    shippingMethodName: quote.shippingMethodName,
    discountAmount: quote.discountAmount,
    discountCode: quote.discountCode,
    taxAmount: quote.taxAmount,
    totalAmount: quote.totalAmount,
    currency: quote.currency,
    ...extra,
  })
  await applyInventory(order)
  await consumeDiscount(quote.discountCode)
  await Cart.updateOne({ user: quote.user }, { $set: { items: [] } })
  await onOrderChange()
  try {
    const user = await User.findById(quote.user)
    if (user) await sendEmail({ to: user.email, subject: `Your Lembro order ${order.number}`, ...orderConfirmationEmail(order) })
  } catch (error) {
    console.error('Order confirmation email failed', error)
  }
  return (await Order.findById(order._id)) || order
}

// Turns a succeeded Stripe PaymentIntent into an order. Safe to call any number of times
// (browser redirect, webhook retries...) - the PaymentIntent id is unique on the order.
export async function fulfillPaymentIntent(intent) {
  if (intent.status !== 'succeeded') throw new HttpError(400, 'PAYMENT_NOT_COMPLETE', 'The payment has not completed.')
  const { quoteId, userId } = intent.metadata || {}
  if (!quoteId || !userId) throw new HttpError(400, 'PAYMENT_MISMATCH', 'This payment is not linked to a checkout.')

  const existing = await Order.findOne({ paymentIntentId: intent.id })
  if (existing) return { order: existing, created: false }

  const quote = await CheckoutQuote.findOne({ _id: quoteId, user: userId })
  if (!quote) throw new HttpError(409, 'QUOTE_NOT_FOUND', 'The checkout for this payment could not be found.')
  if (intent.amount !== quote.totalAmount || intent.currency !== quote.currency) {
    throw new HttpError(409, 'PAYMENT_MISMATCH', 'The payment amount does not match the checkout.')
  }

  // The customer paid online after a cash-on-delivery order had already been placed from the same checkout.
  const codOrder = await Order.findOne({ quote: quote._id })
  if (codOrder) {
    codOrder.paymentMethod = 'online'
    codOrder.paymentIntentId = intent.id
    codOrder.paymentStatus = 'paid'
    codOrder.paidAt = new Date()
    if (codOrder.status === 'pending') codOrder.status = 'paid'
    codOrder.notes = 'Customer paid online after choosing cash on delivery.'
    await codOrder.save()
    await onOrderChange()
    return { order: codOrder, created: false }
  }

  try {
    const order = await createOrderFromQuote(quote, { paymentIntentId: intent.id, paymentMethod: 'online', status: 'paid', paymentStatus: 'paid', paidAt: new Date() })
    return { order, created: true }
  } catch (error) {
    if (error?.code === 11000) {
      const raced = await Order.findOne({ paymentIntentId: intent.id })
      if (raced) return { order: raced, created: false }
    }
    throw error
  }
}

async function assertInStock(items) {
  for (const item of items) {
    const product = await Product.findOne({ _id: item.product, status: 'published' })
    const variant = product?.variants.id(item.variantId)
    if (!product || !variant || variant.status !== 'active' || variant.stock < item.quantity) {
      throw new HttpError(409, 'INSUFFICIENT_STOCK', `"${item.productNameSnapshot}" is no longer available in the requested quantity. Please review your cart.`)
    }
  }
}

// Cash on delivery: no payment is taken now. The order starts "pending" with payment "pending"
// until staff move it through fulfilment and the courier collects the cash.
export async function placeCodOrder(quote, phone) {
  const existing = await Order.findOne({ quote: quote._id })
  if (existing) return { order: existing, created: false }
  if (!quote.shippingAddress?.phone) {
    if (!phone) throw new HttpError(400, 'PHONE_REQUIRED', 'A phone number is required so the courier can reach you.')
    quote.shippingAddress.phone = phone
  }
  await assertInStock(quote.items)
  try {
    const order = await createOrderFromQuote(quote, { paymentMethod: 'cod', status: 'pending', paymentStatus: 'pending' })
    return { order, created: true }
  } catch (error) {
    if (error?.code === 11000) {
      const raced = await Order.findOne({ quote: quote._id })
      if (raced) return { order: raced, created: false }
    }
    throw error
  }
}
