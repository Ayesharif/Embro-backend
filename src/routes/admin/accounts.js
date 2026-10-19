import { Router } from 'express'
import Order from '../../models/Order.js'
import Product from '../../models/Product.js'
import { ROLE_GROUPS, requireRole } from '../../middleware/auth.js'
import { asyncHandler, HttpError } from '../../utils/httpError.js'
import { parse, v } from '../../utils/validation.js'
import { buildAccountsReport } from '../../services/accounts.js'
import { currencyInfo } from '../../config/currencies.js'
import { cacheResponse } from '../../cache/middleware.js'
import { NS, TTL } from '../../cache/namespaces.js'
import { getCurrencyCode } from '../../services/settings.js'

const router = Router()
const MAX_ORDERS = 50_000

function validTimeZone(value) {
  try {
    new Intl.DateTimeFormat('en', { timeZone: value })
    return true
  } catch {
    return false
  }
}

router.get('/accounts', requireRole(...ROLE_GROUPS.finance), cacheResponse({ name: 'admin-accounts', namespaces: [NS.ADMIN_STATS], ttl: TTL.accounts, scope: 'staff', allowedQuery: ['from', 'to', 'tz'] }), asyncHandler(async (request, response) => {
  const input = parse({ from: v.optional(v.date()), to: v.optional(v.date()), tz: v.optional(v.string({ min: 1, max: 60 })) }, request.query)
  const to = input.to || new Date()
  const from = input.from || new Date(to.getTime() - 30 * 86_400_000)
  if (from > to) throw new HttpError(400, 'VALIDATION_ERROR', 'The start date must be before the end date.')
  if (input.tz && !validTimeZone(input.tz)) throw new HttpError(400, 'VALIDATION_ERROR', 'Unknown time zone.')

  const currency = await getCurrencyCode()
  const inRange = { createdAt: { $gte: from, $lte: to }, status: { $ne: 'cancelled' } }
  const [orders, otherCurrencyOrders, [inventory]] = await Promise.all([
    // Amounts in different currencies can't be added together, so reports cover the current store currency only.
    Order.find({ ...inRange, currency: currency.toLowerCase() })
      .select('createdAt status paymentMethod paymentStatus subtotalAmount discountAmount shippingAmount taxAmount totalAmount refundedAmount items.product items.productNameSnapshot items.quantity items.lineTotalAmount items.costAmountSnapshot')
      .sort({ createdAt: -1 })
      .limit(MAX_ORDERS)
      .lean(),
    Order.countDocuments({ ...inRange, currency: { $ne: currency.toLowerCase() } }),
    // Stock on hand valued at purchasing cost and at current selling price.
    Product.aggregate([
      { $match: { status: { $ne: 'archived' } } },
      { $unwind: '$variants' },
      { $match: { 'variants.status': 'active' } },
      { $group: {
        _id: null,
        units: { $sum: '$variants.stock' },
        atCost: { $sum: { $multiply: ['$variants.stock', '$variants.costAmount'] } },
        atRetail: { $sum: { $multiply: ['$variants.stock', { $round: [{ $multiply: ['$variants.sellingAmount', { $subtract: [1, { $divide: [{ $ifNull: ['$variants.discountPercent', 0] }, 100] }] }] }, 0] }] } },
      } },
    ]),
  ])

  response.json({
    ...buildAccountsReport(orders, { from, to, timeZone: input.tz || 'UTC' }),
    inventory: { units: inventory?.units || 0, atCost: inventory?.atCost || 0, atRetail: inventory?.atRetail || 0 },
    truncated: orders.length >= MAX_ORDERS,
    currency: currencyInfo(currency),
    otherCurrencyOrders,
  })
}))

export default router
