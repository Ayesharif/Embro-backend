import { Router } from 'express'
import { getCacheStats } from '../../cache/cache.js'
import { NS, purgeAll } from '../../cache/namespaces.js'
import { asyncHandler } from '../../utils/httpError.js'

// Mounted behind the admin/super_admin gate in admin/index.js.
const router = Router()

// Hit/miss counters since this process started (per instance), plus the connection state.
router.get('/cache', (request, response) => response.json(getCacheStats()))

// Invalidates every cached response (all namespaces) without touching other data in Redis.
router.post('/cache/purge', asyncHandler(async (request, response) => {
  await purgeAll()
  response.json({ purged: Object.values(NS) })
}))

export default router
