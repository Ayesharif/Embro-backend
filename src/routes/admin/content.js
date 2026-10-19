import { Router } from 'express'
import ContactMessage from '../../models/ContactMessage.js'
import Discount from '../../models/Discount.js'
import Order from '../../models/Order.js'
import Product from '../../models/Product.js'
import Review from '../../models/Review.js'
import User from '../../models/User.js'
import { ROLE_GROUPS, requireRole } from '../../middleware/auth.js'
import { asyncHandler, HttpError } from '../../utils/httpError.js'
import { parse, parseId, v } from '../../utils/validation.js'
import { recalculateRating } from '../../services/products.js'
import { cacheResponse } from '../../cache/middleware.js'
import { NS, TTL, onReviewChange } from '../../cache/namespaces.js'
import { getCurrencyCode } from '../../services/settings.js'

const router = Router()

router.get('/dashboard', requireRole(...ROLE_GROUPS.finance), cacheResponse({ name: 'admin-dashboard', namespaces: [NS.ADMIN_STATS], ttl: TTL.dashboard, scope: 'staff' }), asyncHandler(async (request, response) => {
  const currency = (await getCurrencyCode()).toLowerCase()
  const [products, customers, orders, revenue, statusCounts, lowStock, recentOrders, attention] = await Promise.all([
    Product.countDocuments({ status: { $ne: 'archived' } }),
    User.countDocuments({ status: 'active', role: 'customer' }),
    Order.countDocuments(),
    Order.aggregate([
      { $match: { currency, paymentStatus: { $in: ['paid', 'partially_refunded'] } } },
      { $group: { _id: null, total: { $sum: { $subtract: ['$totalAmount', '$refundedAmount'] } } } },
    ]),
    Order.aggregate([{ $group: { _id: '$status', count: { $sum: 1 } } }]),
    Product.aggregate([
      { $match: { status: 'published' } },
      { $unwind: '$variants' },
      { $match: { 'variants.status': 'active', 'variants.stock': { $lte: 5 } } },
      { $sort: { 'variants.stock': 1 } },
      { $limit: 8 },
      { $project: { name: 1, color: '$variants.color', size: '$variants.size', stock: '$variants.stock' } },
    ]),
    Order.find().populate('user', 'name email').sort({ createdAt: -1 }).limit(8),
    Order.countDocuments({ requiresAttention: true }),
  ])
  response.json({
    metrics: { products, customers, orders, revenueAmount: revenue[0]?.total || 0, ordersNeedingAttention: attention },
    ordersByStatus: Object.fromEntries(statusCounts.map((row) => [row._id, row.count])),
    lowStock: lowStock.map((row) => ({ id: `${row._id}-${row.color || ''}-${row.size || ''}`, name: [row.name, [row.color, row.size].filter(Boolean).join(' / ')].filter(Boolean).join(' - '), stock: row.stock })),
    recentOrders,
  })
}))

const discountSchema = {
  code: v.string({ min: 3, max: 40, pattern: /^[A-Za-z0-9_-]+$/, patternMessage: 'may only contain letters, numbers, - and _.' }),
  description: v.optional(v.string({ min: 0, max: 200 })),
  type: v.oneOf(['percentage', 'fixed']),
  value: v.integer({ min: 1, max: 100_000_000 }),
  startsAt: v.optional(v.date()),
  endsAt: v.optional(v.date()),
  minimumOrderAmount: v.optional(v.integer({ min: 0, max: 100_000_000 })),
  usageLimit: v.optional(v.integer({ min: 1, max: 1_000_000 })),
  isActive: v.optional(v.boolean()),
}

function assertDiscountValue(discount) {
  if (discount.type === 'percentage' && discount.value > 100) throw new HttpError(400, 'VALIDATION_ERROR', 'A percentage discount cannot exceed 100.')
}

router.get('/discounts', requireRole(...ROLE_GROUPS.catalog), asyncHandler(async (request, response) => {
  response.json({ data: await Discount.find().sort({ createdAt: -1 }) })
}))

router.post('/discounts', requireRole(...ROLE_GROUPS.catalog), asyncHandler(async (request, response) => {
  const input = parse(discountSchema, request.body)
  assertDiscountValue(input)
  response.status(201).json({ discount: await Discount.create(input) })
}))

router.patch('/discounts/:id', requireRole(...ROLE_GROUPS.catalog), asyncHandler(async (request, response) => {
  const changes = parse(discountSchema, request.body, { partial: true })
  const discount = await Discount.findById(parseId(request.params.id, 'discount id'))
  if (!discount) throw new HttpError(404, 'DISCOUNT_NOT_FOUND', 'Discount not found.')
  Object.assign(discount, changes)
  assertDiscountValue(discount)
  await discount.save()
  response.json({ discount })
}))

router.delete('/discounts/:id', requireRole(...ROLE_GROUPS.catalog), asyncHandler(async (request, response) => {
  await Discount.findByIdAndDelete(parseId(request.params.id, 'discount id'))
  response.status(204).end()
}))

router.get('/reviews', requireRole(...ROLE_GROUPS.inbox), asyncHandler(async (request, response) => {
  const reviews = await Review.find().populate('product', 'name').populate('user', 'name email').sort({ createdAt: -1 }).limit(200)
  response.json({ data: reviews })
}))

router.patch('/reviews/:id', requireRole(...ROLE_GROUPS.inbox), asyncHandler(async (request, response) => {
  const { status } = parse({ status: v.oneOf(['pending', 'approved', 'rejected', 'hidden']) }, request.body)
  const review = await Review.findByIdAndUpdate(parseId(request.params.id, 'review id'), { $set: { status } }, { new: true })
  if (!review) throw new HttpError(404, 'REVIEW_NOT_FOUND', 'Review not found.')
  await recalculateRating(review.product)
  await onReviewChange()
  response.json({ review })
}))

router.get('/contacts', requireRole(...ROLE_GROUPS.inbox), asyncHandler(async (request, response) => {
  response.json({ data: await ContactMessage.find().sort({ createdAt: -1 }).limit(200) })
}))

router.patch('/contacts/:id', requireRole(...ROLE_GROUPS.inbox), asyncHandler(async (request, response) => {
  const { status } = parse({ status: v.oneOf(['new', 'in_progress', 'resolved', 'spam']) }, request.body)
  const message = await ContactMessage.findByIdAndUpdate(parseId(request.params.id, 'message id'), { $set: { status } }, { new: true })
  if (!message) throw new HttpError(404, 'CONTACT_NOT_FOUND', 'Contact message not found.')
  response.json({ message })
}))

export default router
