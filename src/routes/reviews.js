import { Router } from 'express'
import Order from '../models/Order.js'
import Product from '../models/Product.js'
import Review from '../models/Review.js'
import { asyncHandler, HttpError } from '../utils/httpError.js'
import { parse, parseId, v } from '../utils/validation.js'
import { requireAuth } from '../middleware/auth.js'
import { cacheResponse } from '../cache/middleware.js'
import { NS, TTL } from '../cache/namespaces.js'

const router = Router()

function serializeReview(review) {
  return {
    id: review.id, rating: review.rating, title: review.title, body: review.body,
    verifiedPurchase: review.verifiedPurchase, createdAt: review.createdAt, author: review.user?.name?.split(' ')[0] || 'Customer',
  }
}

export async function listProductReviews(productId) {
  const reviews = await Review.find({ product: productId, status: 'approved' }).populate('user', 'name').sort({ createdAt: -1 }).limit(100)
  return reviews.map(serializeReview)
}

// Latest approved reviews + overall rating, for the home page.
router.get('/featured', cacheResponse({ name: 'featured-reviews', namespaces: [NS.REVIEWS, NS.PRODUCTS], ttl: TTL.reviews }), asyncHandler(async (request, response) => {
  const [reviews, [summary]] = await Promise.all([
    Review.find({ status: 'approved', rating: { $gte: 4 } }).populate('user', 'name').populate('product', 'name slug status').sort({ createdAt: -1 }).limit(12),
    Review.aggregate([{ $match: { status: 'approved' } }, { $group: { _id: null, average: { $avg: '$rating' }, count: { $sum: 1 } } }]),
  ])
  response.json({
    data: reviews.filter((review) => review.product?.status === 'published').map((review) => ({
      ...serializeReview(review), product: { name: review.product.name, slug: review.product.slug },
    })),
    summary: { average: summary ? Math.round(summary.average * 10) / 10 : 0, count: summary?.count || 0 },
  })
}))

// Products the signed-in customer has received/ordered and not reviewed yet.
router.get('/eligible', requireAuth, asyncHandler(async (request, response) => {
  const orders = await Order.find({ user: request.user._id, status: { $in: ['paid', 'processing', 'shipped', 'delivered'] } }).select('items.product')
  const bought = [...new Set(orders.flatMap((order) => order.items.map((item) => String(item.product))))]
  const reviewed = (await Review.find({ user: request.user._id, product: { $in: bought } }).select('product')).map((review) => String(review.product))
  const products = await Product.find({ _id: { $in: bought.filter((id) => !reviewed.includes(id)) }, status: 'published' }).select('name slug')
  response.json({ data: products.map((product) => ({ id: product.id, name: product.name, slug: product.slug })) })
}))

router.get('/', asyncHandler(async (request, response) => {
  const productId = parseId(request.query.productId, 'product id')
  response.json({ data: await listProductReviews(productId) })
}))

export async function myReview(productId, userId) {
  if (!userId) return null
  const review = await Review.findOne({ product: productId, user: userId }).select('status rating')
  return review ? { status: review.status, rating: review.rating } : null
}

router.post('/', requireAuth, asyncHandler(async (request, response) => {
  const input = parse({
    productId: v.objectId(),
    rating: v.integer({ min: 1, max: 5 }),
    title: v.optional(v.string({ min: 0, max: 120 })),
    body: v.string({ min: 10, max: 3000 }),
  }, request.body)
  if (!await Product.exists({ _id: input.productId, status: 'published' })) throw new HttpError(404, 'PRODUCT_NOT_FOUND', 'Product not found.')
  const verifiedPurchase = Boolean(await Order.exists({
    user: request.user._id,
    'items.product': input.productId,
    status: { $in: ['paid', 'processing', 'shipped', 'delivered'] },
  }))
  try {
    await Review.create({ product: input.productId, user: request.user._id, rating: input.rating, title: input.title, body: input.body, status: 'pending', verifiedPurchase })
  } catch (error) {
    if (error?.code === 11000) throw new HttpError(409, 'REVIEW_EXISTS', 'You have already reviewed this product.')
    throw error
  }
  response.status(201).json({ message: 'Thanks! Your review will appear once it has been approved.' })
}))

export default router
