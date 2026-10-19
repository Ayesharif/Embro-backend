import { Router } from 'express'
import Stripe from 'stripe'
import CheckoutQuote from '../models/CheckoutQuote.js'
import Order from '../models/Order.js'
import User from '../models/User.js'
import { env } from '../config/env.js'
import { onOrderChange } from '../cache/namespaces.js'
import { getCurrencyCode } from '../services/settings.js'
import { requireAuth } from '../middleware/auth.js'
import { HttpError, asyncHandler } from '../utils/httpError.js'
import { parse, v } from '../utils/validation.js'
import { fulfillPaymentIntent } from '../services/orders.js'

const router = Router()
export const stripe = env.stripe.secretKey ? new Stripe(env.stripe.secretKey) : null

function requireStripe() {
  if (!stripe) throw new HttpError(503, 'STRIPE_NOT_CONFIGURED', 'Payments are not configured.')
  return stripe
}

async function ownedIntent(request) {
  const intent = await requireStripe().paymentIntents.retrieve(request.params.id)
  const isOwner = intent.metadata?.userId === request.user.id
  if (!isOwner && !['admin', 'super_admin'].includes(request.user.role)) {
    // Same answer as "not found" so payment ids can't be probed.
    throw new HttpError(404, 'PAYMENT_NOT_FOUND', 'Payment not found.')
  }
  return intent
}

// The amount is read from the server-side quote. The browser only says *which* quote to pay.
router.post('/intent', requireAuth, asyncHandler(async (request, response) => {
  const client = requireStripe()
  const { quoteId } = parse({ quoteId: v.objectId() }, request.body)
  const quote = await CheckoutQuote.findOne({ _id: quoteId, user: request.user._id })
  if (!quote || quote.expiresAt < new Date() || (!quote.paymentIntentId && quote.currency !== (await getCurrencyCode()).toLowerCase())) throw new HttpError(400, 'QUOTE_EXPIRED', 'Your checkout has expired. Please review your order again.')
  if (quote.paymentIntentId && await Order.exists({ paymentIntentId: quote.paymentIntentId })) {
    throw new HttpError(409, 'ALREADY_PAID', 'This checkout has already been paid.')
  }

  if (quote.paymentIntentId) {
    const existing = await client.paymentIntents.retrieve(quote.paymentIntentId)
    if (['requires_payment_method', 'requires_confirmation', 'requires_action'].includes(existing.status)) {
      return response.json({ id: existing.id, clientSecret: existing.client_secret, status: existing.status })
    }
  }

  const user = await User.findById(request.user._id)
  const intent = await client.paymentIntents.create({
    amount: quote.totalAmount,
    currency: quote.currency,
    // Cards and wallets only: redirect-based methods would need a return page.
    automatic_payment_methods: { enabled: true, allow_redirects: 'never' },
    receipt_email: user.email,
    metadata: { userId: request.user.id, quoteId: quote.id },
  }, { idempotencyKey: `intent-${quote.id}` })
  quote.paymentIntentId = intent.id
  await quote.save()
  response.status(201).json({ id: intent.id, clientSecret: intent.client_secret, status: intent.status })
}))

router.get('/:id', requireAuth, asyncHandler(async (request, response) => {
  const intent = await ownedIntent(request)
  response.json({ id: intent.id, status: intent.status, amount: intent.amount, currency: intent.currency })
}))

router.post('/:id/cancel', requireAuth, asyncHandler(async (request, response) => {
  const intent = await ownedIntent(request)
  if (!['requires_payment_method', 'requires_confirmation', 'requires_action'].includes(intent.status)) {
    throw new HttpError(409, 'NOT_CANCELLABLE', 'This payment can no longer be cancelled.')
  }
  const cancelled = await requireStripe().paymentIntents.cancel(intent.id)
  response.json({ id: cancelled.id, status: cancelled.status })
}))

// Mounted with express.raw() in app.js so the signature can be verified against the exact bytes.
router.post('/webhook', asyncHandler(async (request, response) => {
  if (!stripe || !env.stripe.webhookSecret) throw new HttpError(503, 'STRIPE_NOT_CONFIGURED', 'Webhook verification is not configured.')
  let event
  try {
    event = stripe.webhooks.constructEvent(request.body, request.headers['stripe-signature'], env.stripe.webhookSecret)
  } catch {
    throw new HttpError(400, 'INVALID_WEBHOOK', 'Stripe webhook signature is invalid.')
  }
  const object = event.data.object
  if (event.type === 'payment_intent.succeeded') {
    // The webhook is the source of truth: the order exists even if the customer closes the tab.
    await fulfillPaymentIntent(object)
  } else if (event.type === 'charge.refunded' && object.payment_intent) {
    const order = await Order.findOne({ paymentIntentId: object.payment_intent })
    if (order && object.amount_refunded > order.refundedAmount) {
      const full = object.amount_refunded >= order.totalAmount
      order.refundedAmount = object.amount_refunded
      order.paymentStatus = full ? 'refunded' : 'partially_refunded'
      if (full) order.status = 'refunded'
      await order.save()
      await onOrderChange()
    }
  }
  response.json({ received: true })
}))

export default router
