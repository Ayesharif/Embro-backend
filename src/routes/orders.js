import { Router } from 'express'
import CheckoutQuote from '../models/CheckoutQuote.js'
import Order from '../models/Order.js'
import Shipment from '../models/Shipment.js'
import { asyncHandler, HttpError } from '../utils/httpError.js'
import { parse, v } from '../utils/validation.js'
import { requireAuth } from '../middleware/auth.js'
import { formatMoney } from '../config/currencies.js'
import { getSettings } from '../services/settings.js'
import { fulfillPaymentIntent, placeCodOrder } from '../services/orders.js'
import { stripe } from './payments.js'

const router = Router()
router.use(requireAuth)

router.get('/', asyncHandler(async (request, response) => {
  const orders = await Order.find({ user: request.user._id }).sort({ createdAt: -1 }).limit(100)
  response.json({ data: orders })
}))

router.get('/:id', asyncHandler(async (request, response) => {
  const { id } = request.params
  const lookup = /^[a-f\d]{24}$/i.test(id) ? { _id: id } : { number: id.toUpperCase() }
  const order = await Order.findOne({ ...lookup, user: request.user._id })
  if (!order) throw new HttpError(404, 'ORDER_NOT_FOUND', 'Order not found.')
  const shipments = await Shipment.find({ order: order._id }).sort({ createdAt: 1 })
  response.json({ order, shipments })
}))

// Called by the browser right after Stripe confirms the card. Totals come from the verified
// PaymentIntent + stored quote; nothing in the request body is trusted for pricing.
router.post('/', asyncHandler(async (request, response) => {
  if (!stripe) throw new HttpError(503, 'STRIPE_NOT_CONFIGURED', 'Payments are not configured.')
  const { paymentIntentId } = parse({ paymentIntentId: v.string({ min: 5, max: 100, pattern: /^pi_[A-Za-z0-9_]+$/ }) }, request.body)
  const intent = await stripe.paymentIntents.retrieve(paymentIntentId)
  if (intent.metadata?.userId !== request.user.id) throw new HttpError(403, 'PAYMENT_MISMATCH', 'The payment does not belong to this account.')
  const { order, created } = await fulfillPaymentIntent(intent)
  response.status(created ? 201 : 200).json({ order })
}))


// Cash on delivery. Like online payments, the total comes from the server-side quote.
router.post('/cod', asyncHandler(async (request, response) => {
  const { quoteId, phone } = parse({ quoteId: v.objectId(), phone: v.optional(v.string({ min: 5, max: 30, pattern: /^[0-9+()\-\s]+$/, patternMessage: 'must be a valid phone number.' })) }, request.body)
  const { cod, currency } = await getSettings()
  if (!cod.enabled) throw new HttpError(403, 'COD_DISABLED', 'Cash on delivery is not available right now.')
  const quote = await CheckoutQuote.findOne({ _id: quoteId, user: request.user._id })
  if (!quote || quote.expiresAt < new Date() || quote.currency !== currency.toLowerCase()) throw new HttpError(400, 'QUOTE_EXPIRED', 'Your checkout has expired. Please review your order again.')
  if (cod.maxAmount && quote.totalAmount > cod.maxAmount) {
    throw new HttpError(400, 'COD_LIMIT', `Cash on delivery is available for orders up to ${formatMoney(cod.maxAmount, currency)}. Please pay online.`)
  }
  const { order, created } = await placeCodOrder(quote, phone)
  // The customer may have opened a card payment for this quote first; make sure it can't be charged later.
  if (created && quote.paymentIntentId && stripe) await stripe.paymentIntents.cancel(quote.paymentIntentId).catch(() => {})
  response.status(created ? 201 : 200).json({ order })
}))

export default router
