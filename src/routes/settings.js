import { Router } from 'express'
import { cacheResponse } from '../cache/middleware.js'
import { NS, TTL } from '../cache/namespaces.js'
import { asyncHandler } from '../utils/httpError.js'
import { publicSettings } from '../services/settings.js'

const router = Router()

// What the storefront needs before it can format a price.
router.get('/public', cacheResponse({ name: 'public-settings', namespaces: [NS.SETTINGS], ttl: TTL.settings }), asyncHandler(async (request, response) => {
  response.json(await publicSettings())
}))

export default router
