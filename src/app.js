import './config/mongoose.js'
import express from 'express'
import cors from 'cors'
import helmet from 'helmet'
import cookieParser from 'cookie-parser'
import { env } from './config/env.js'
import { errorHandler, notFound } from './middleware/errorHandler.js'
import { globalLimiter } from './middleware/rateLimits.js'
import adminRoutes from './routes/admin/index.js'
import addressRoutes from './routes/addresses.js'
import authRoutes from './routes/auth.js'
import cartRoutes from './routes/cart.js'
import categoryRoutes from './routes/categories.js'
import checkoutRoutes from './routes/checkout.js'
import healthRoutes from './routes/health.js'
import oauthCallbackRoutes from './routes/oauthCallback.js'
import orderRoutes from './routes/orders.js'
import paymentRoutes from './routes/payments.js'
import productRoutes from './routes/products.js'
import publicFormRoutes from './routes/publicForms.js'
import reviewRoutes from './routes/reviews.js'
import seoRoutes from './routes/seo.js'
import settingsRoutes from './routes/settings.js'
import uploadRoutes from './routes/uploads.js'
import wishlistRoutes from './routes/wishlist.js'
import { listProductReviews, myReview } from './routes/reviews.js'
import { optionalAuth } from './middleware/auth.js'
import { cached } from './cache/cache.js'
import { NS, TTL } from './cache/namespaces.js'
import { asyncHandler } from './utils/httpError.js'
import { parseId } from './utils/validation.js'

const app = express()

app.set('trust proxy', env.trustProxy)
app.disable('x-powered-by')
app.use(helmet())
app.use(cors({
  origin: env.webAppUrl,
  credentials: true,
  methods: ['GET', 'POST', 'PATCH', 'DELETE'],
  allowedHeaders: ['Content-Type', 'Authorization', 'X-Guest-Id'],
}))
// Stripe signs the raw request body, so this must come before express.json().
app.use('/api/v1/payments/webhook', express.raw({ type: 'application/json', limit: '1mb' }))
app.use(express.json({ limit: '100kb' }))
app.use(cookieParser())
app.use(globalLimiter)

app.get('/', (request, response) => response.json({ name: 'Lembro API', version: 'v1', status: 'ok' }))
app.use(seoRoutes)
app.use('/api/v1/health', healthRoutes)
app.use('/api/v1/auth/oauth', oauthCallbackRoutes)
app.use('/api/v1/auth', authRoutes)
app.use('/api/v1/products', productRoutes)
app.get('/api/v1/products/:id/reviews', optionalAuth, asyncHandler(async (request, response) => {
  const productId = parseId(request.params.id, 'product id')
  // Only the shared list is cached; `mine` depends on who is asking, so it is always read fresh.
  const data = await cached({ name: 'product-reviews', namespaces: [NS.REVIEWS], ttl: TTL.reviews, fingerprint: productId }, () => listProductReviews(productId))
  response.json({ data, mine: await myReview(productId, request.user?._id) })
}))
app.use('/api/v1/categories', categoryRoutes)
app.use('/api/v1/cart', cartRoutes)
app.use('/api/v1/wishlist', wishlistRoutes)
app.use('/api/v1/me/addresses', addressRoutes)
app.use('/api/v1/orders', orderRoutes)
app.use('/api/v1/reviews', reviewRoutes)
app.use('/api/v1/payments', paymentRoutes)
app.use('/api/v1/settings', settingsRoutes)
app.use('/api/v1/uploads', uploadRoutes)
app.use('/api/v1/admin', adminRoutes)
app.use('/api/v1', checkoutRoutes)
app.use('/api/v1', publicFormRoutes)
app.use(notFound)
app.use(errorHandler)

export default app
