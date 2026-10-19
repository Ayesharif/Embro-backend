import { Router } from 'express'
import Category from '../models/Category.js'
import { cacheResponse } from '../cache/middleware.js'
import { NS, TTL } from '../cache/namespaces.js'
import { asyncHandler } from '../utils/httpError.js'

const router = Router()

router.get('/', cacheResponse({ name: 'categories', namespaces: [NS.CATEGORIES], ttl: TTL.categories }), asyncHandler(async (request, response) => {
  const categories = await Category.find({ status: 'active' }).sort({ sortOrder: 1, name: 1 })
  response.json({
    data: categories.map((category) => ({
      id: category.id, name: category.name, slug: category.slug, description: category.description, image: category.image?.secureUrl,
    })),
  })
}))

export default router
