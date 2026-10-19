import { Router } from 'express'
import mongoose from 'mongoose'
import { getCacheStats } from '../cache/cache.js'

const router = Router()

router.get('/live', (request, response) => response.json({ status: 'ok' }))
router.get('/ready', (request, response) => {
  const ready = mongoose.connection.readyState === 1
  // Redis is an optimisation, never a dependency: it is reported but doesn't affect readiness.
  const cache = getCacheStats()
  response.status(ready ? 200 : 503).json({
    status: ready ? 'ready' : 'not_ready',
    database: ready ? 'connected' : 'disconnected',
    cache: cache.enabled ? (cache.connected ? 'connected' : 'unavailable') : 'disabled',
  })
})

export default router
