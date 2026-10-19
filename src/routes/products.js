import { Router } from 'express'
import mongoose from 'mongoose'
import Category from '../models/Category.js'
import Product from '../models/Product.js'
import { asyncHandler, HttpError } from '../utils/httpError.js'
import { escapeRegex } from '../utils/text.js'
import { parse, v } from '../utils/validation.js'
import { cacheResponse } from '../cache/middleware.js'
import { NS, TTL } from '../cache/namespaces.js'
import { serializeProduct } from '../services/products.js'

const router = Router()

const SORTS = {
  newest: { createdAt: -1, _id: -1 },
  price_asc: { priceFrom: 1, _id: 1 },
  price_desc: { priceFrom: -1, _id: 1 },
  rating: { ratingAverage: -1, ratingCount: -1, _id: 1 },
  name: { name: 1, _id: 1 },
}

const querySchema = {
  q: v.optional(v.string({ min: 1, max: 80 })),
  category: v.optional(v.string({ min: 1, max: 80 })),
  featured: v.optional(v.boolean({ coerce: true })),
  newArrival: v.optional(v.boolean({ coerce: true })),
  sort: v.optional(v.oneOf(Object.keys(SORTS))),
  page: v.optional(v.integer({ min: 1, max: 10000, coerce: true })),
  limit: v.optional(v.integer({ min: 1, max: 48, coerce: true })),
}

// Public catalogue data: identical for everyone, so one shared entry per distinct filter/sort/page.
router.get('/', cacheResponse({ name: 'product-list', namespaces: [NS.PRODUCTS], ttl: TTL.productList, allowedQuery: Object.keys(querySchema) }), asyncHandler(async (request, response) => {
  const { q, category, featured, newArrival, sort = 'newest', page = 1, limit = 12 } = parse(querySchema, request.query)
  // Products without an active variant can't be bought, so they stay out of the shop.
  const filter = { status: 'published', priceFrom: { $ne: null } }
  if (category) {
    const match = mongoose.isValidObjectId(category) && /^[a-f\d]{24}$/i.test(category)
      ? { _id: category }
      : { slug: category.toLowerCase() }
    const found = await Category.findOne({ ...match, status: 'active' }).select('_id')
    filter.category = found ? found._id : null
  }
  if (featured) filter.isFeatured = true
  if (newArrival) filter.isNewArrival = true
  if (q) filter.name = { $regex: escapeRegex(q), $options: 'i' }

  const [total, products] = await Promise.all([
    Product.countDocuments(filter),
    Product.find(filter).sort(SORTS[sort]).skip((page - 1) * limit).limit(limit).populate('category', 'name slug'),
  ])
  const totalPages = Math.max(1, Math.ceil(total / limit))
  response.json({
    data: products.map(serializeProduct),
    pagination: { page, limit, total, totalPages, hasNextPage: page < totalPages },
  })
}))

router.get('/:idOrSlug', cacheResponse({ name: 'product-detail', namespaces: [NS.PRODUCTS], ttl: TTL.productDetail, parts: (request) => request.params.idOrSlug.toLowerCase() }), asyncHandler(async (request, response) => {
  const { idOrSlug } = request.params
  const lookup = /^[a-f\d]{24}$/i.test(idOrSlug) ? { _id: idOrSlug } : { slug: idOrSlug.toLowerCase() }
  const product = await Product.findOne({ ...lookup, status: 'published' }).populate('category', 'name slug')
  if (!product) throw new HttpError(404, 'PRODUCT_NOT_FOUND', 'Product not found.')
  response.json({ product: serializeProduct(product) })
}))

export default router
