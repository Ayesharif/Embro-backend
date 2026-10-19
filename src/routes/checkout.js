import { Router } from 'express'
import Address from '../models/Address.js'
import CheckoutQuote from '../models/CheckoutQuote.js'
import Discount from '../models/Discount.js'
import ShippingMethod from '../models/ShippingMethod.js'
import { env } from '../config/env.js'
import { formatMoney } from '../config/currencies.js'
import { cacheResponse } from '../cache/middleware.js'
import { NS, TTL } from '../cache/namespaces.js'
import { getSettings } from '../services/settings.js'
import { asyncHandler, HttpError } from '../utils/httpError.js'
import { computeTotals } from '../utils/pricing.js'
import { parse, v } from '../utils/validation.js'
import { requireAuth } from '../middleware/auth.js'
import { loadCart, priceableLines } from '../services/cart.js'
import { addressFields } from './addresses.js'

const router = Router()

router.get('/shipping/methods', cacheResponse({ name: 'shipping-methods', namespaces: [NS.SHIPPING], ttl: TTL.shipping }), asyncHandler(async (request, response) => {
  const methods = await ShippingMethod.find({ isActive: true }).sort({ amount: 1 })
  response.json({
    data: methods.map((method) => ({
      id: method.id, name: method.name, code: method.code, description: method.description, image: method.image?.secureUrl, amount: method.amount,
      estimatedDaysMin: method.estimatedDaysMin, estimatedDaysMax: method.estimatedDaysMax,
    })),
  })
}))

router.get('/checkout/options', cacheResponse({ name: 'checkout-options', namespaces: [NS.SETTINGS], ttl: TTL.settings }), asyncHandler(async (request, response) => {
  const { cod } = await getSettings()
  response.json({ cod: { enabled: cod.enabled, maxAmount: cod.maxAmount || null } })
}))

const shippingAddressFields = Object.fromEntries(Object.entries(addressFields).filter(([key]) => key !== 'label'))

const quoteSchema = {
  shippingMethodId: v.objectId(),
  addressId: v.optional(v.objectId()),
  address: v.optional(v.object(shippingAddressFields)),
  discountCode: v.optional(v.string({ min: 0, max: 40 })),
}

async function findDiscount(code, subtotal, currency) {
  const now = new Date()
  const discount = await Discount.findOne({
    code: code.toUpperCase(),
    isActive: true,
    startsAt: { $lte: now },
    $or: [{ endsAt: null }, { endsAt: { $exists: false } }, { endsAt: { $gt: now } }],
  })
  if (!discount) throw new HttpError(400, 'INVALID_DISCOUNT', 'That discount code is not valid.')
  if (discount.usageLimit && discount.usedCount >= discount.usageLimit) throw new HttpError(400, 'DISCOUNT_EXHAUSTED', 'That discount code has been fully redeemed.')
  if (subtotal < (discount.minimumOrderAmount || 0)) {
    throw new HttpError(400, 'DISCOUNT_MINIMUM', `This code needs a minimum order of ${formatMoney(discount.minimumOrderAmount, currency)}.`)
  }
  return discount
}

router.post('/checkout/quote', requireAuth, asyncHandler(async (request, response) => {
  const input = parse(quoteSchema, request.body)
  const storeCurrency = (await getSettings()).currency
  const cart = await loadCart({ user: request.user._id }, { create: false })
  const lines = priceableLines(cart)

  const method = await ShippingMethod.findOne({ _id: input.shippingMethodId, isActive: true })
  if (!method) throw new HttpError(400, 'INVALID_SHIPPING_METHOD', 'Choose a valid shipping method.')

  let shippingAddress = input.address
  if (input.addressId) {
    const saved = await Address.findOne({ _id: input.addressId, user: request.user._id })
    if (!saved) throw new HttpError(404, 'ADDRESS_NOT_FOUND', 'Address not found.')
    const { name, line1, line2, city, state, postalCode, country, phone } = saved
    shippingAddress = { name, line1, line2, city, state, postalCode, country, phone }
  }
  if (!shippingAddress) throw new HttpError(400, 'ADDRESS_REQUIRED', 'A delivery address is required.')

  const subtotal = lines.reduce((sum, line) => sum + line.lineTotalAmount, 0)
  const discount = input.discountCode ? await findDiscount(input.discountCode, subtotal, storeCurrency) : null
  const totals = computeTotals({
    lines, shippingAmount: method.amount, discount, taxRate: env.taxRate,
  })

  await CheckoutQuote.deleteMany({ user: request.user._id, paymentIntentId: { $exists: false } })
  const quote = await CheckoutQuote.create({
    user: request.user._id,
    shippingAddress,
    shippingMethod: method._id,
    shippingMethodName: method.name,
    items: lines.map((line) => ({
      product: line.productId,
      variantId: line.variantId,
      productNameSnapshot: line.name,
      variantLabel: line.variantLabel,
      skuSnapshot: line.sku,
      image: line.image,
      quantity: line.quantity,
      unitAmount: line.unitAmount,
      lineTotalAmount: line.lineTotalAmount,
    })),
    ...totals,
    discountCode: discount?.code,
    currency: storeCurrency.toLowerCase(),
  })
  response.status(201).json({ quote })
}))

export default router
