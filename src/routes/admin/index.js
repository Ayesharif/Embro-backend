import { Router } from 'express'
import { ROLE_GROUPS, requireAuth, requireRole } from '../../middleware/auth.js'
import accountsRoutes from './accounts.js'
import cacheRoutes from './cache.js'
import catalogRoutes from './catalog.js'
import contentRoutes from './content.js'
import orderRoutes from './orders.js'
import settingsRoutes from './settings.js'
import userRoutes from './users.js'

// Every admin route needs a signed-in staff member; each sub-router then narrows who may do what.
const router = Router()
router.use(requireAuth)
// Order and content routes declare their own role requirements per route.
router.use(orderRoutes)
router.use(contentRoutes)
// Everything below is restricted to admin / super_admin.
router.use(requireRole(...ROLE_GROUPS.catalog))
router.use(accountsRoutes)
router.use(cacheRoutes)
router.use(settingsRoutes)
router.use(catalogRoutes)
router.use(userRoutes)

export default router
