import 'dotenv/config'
import crypto from 'node:crypto'

const nodeEnv = process.env.NODE_ENV || 'development'
const isProduction = nodeEnv === 'production'
const stripTrailingSlash = (value) => value.replace(/\/+$/, '')
const port = Number(process.env.PORT || 4000)

// In development a missing secret gets a temporary random value so the app still boots.
// In production the check at the bottom of this file refuses to start instead.
function devSecret(name) {
  if (process.env[name]) return process.env[name]
  if (isProduction) return undefined
  console.warn(`[env] ${name} is not set - using a temporary random secret (sessions reset on restart).`)
  return crypto.randomBytes(48).toString('hex')
}

function parseTrustProxy(value) {
  if (!value || value === 'false') return false
  if (value === 'true') return 1
  if (/^\d+$/.test(value)) return Number(value)
  return value
}

function positiveNumber(name, fallback) {
  const value = Number(process.env[name])
  return Number.isFinite(value) && value > 0 ? value : fallback
}

const redisUrl = (process.env.REDIS_URL || '').trim()

export const env = {
  nodeEnv,
  isProduction,
  port,
  webAppUrl: stripTrailingSlash(process.env.WEB_APP_URL || 'http://localhost:5173'),
  // Public URL of this API. Used to build the Google OAuth redirect URI so it can never be
  // influenced by a forged Host header.
  apiPublicUrl: stripTrailingSlash(process.env.API_PUBLIC_URL || `http://localhost:${port}`),
  trustProxy: parseTrustProxy(process.env.TRUST_PROXY),
  mongoUri: process.env.MONGODB_URI,
  accessSecret: devSecret('JWT_ACCESS_SECRET'),
  accessExpiresIn: process.env.JWT_ACCESS_EXPIRES_IN || '15m',
  refreshTtlDays: Number(process.env.REFRESH_TTL_DAYS || 30),
  refreshCookieName: process.env.JWT_COOKIE_NAME || 'lembro_refresh',
  // Use 'none' only when the web app and API live on unrelated domains (requires https).
  cookieSameSite: ['lax', 'strict', 'none'].includes(process.env.COOKIE_SAMESITE) ? process.env.COOKIE_SAMESITE : 'lax',
  taxRate: Number(process.env.TAX_RATE ?? 0.05),
  currency: (process.env.CURRENCY || 'usd').toLowerCase(),
  cod: {
    enabled: process.env.COD_ENABLED !== 'false',
    // Largest order total (in cents) accepted for cash on delivery; 0 means no limit.
    maxAmount: Number(process.env.COD_MAX_AMOUNT || 0),
  },
  cache: {
    // Caching needs a Redis URL; CACHE_ENABLED=false switches it off even when one is configured.
    enabled: process.env.CACHE_ENABLED !== 'false' && Boolean(redisUrl),
    redisUrl,
    prefix: (process.env.REDIS_PREFIX || 'lembro:v1').trim(),
    commandTimeoutMs: positiveNumber('REDIS_COMMAND_TIMEOUT_MS', 200),
    connectTimeoutMs: positiveNumber('REDIS_CONNECT_TIMEOUT_MS', 2000),
    maxValueBytes: positiveNumber('CACHE_MAX_VALUE_BYTES', 512 * 1024),
    debug: process.env.CACHE_DEBUG === 'true',
    // Seconds. Short for anything that changes often, longer for near-static data.
    ttl: {
      productList: positiveNumber('CACHE_TTL_PRODUCT_LIST', 300),
      productDetail: positiveNumber('CACHE_TTL_PRODUCT_DETAIL', 120),
      categories: positiveNumber('CACHE_TTL_CATEGORIES', 900),
      settings: positiveNumber('CACHE_TTL_SETTINGS', 300),
      shipping: positiveNumber('CACHE_TTL_SHIPPING', 600),
      reviews: positiveNumber('CACHE_TTL_REVIEWS', 300),
      dashboard: positiveNumber('CACHE_TTL_DASHBOARD', 60),
      accounts: positiveNumber('CACHE_TTL_ACCOUNTS', 60),
    },
  },
  mail: {
    host: process.env.MAIL_HOST,
    port: Number(process.env.MAIL_PORT || 587),
    user: process.env.MAIL_USER,
    password: process.env.MAIL_PASSWORD,
    from: process.env.MAIL_FROM || 'no-reply@example.com',
  },
  google: {
    clientId: process.env.GOOGLE_CLIENT_ID,
    clientSecret: process.env.GOOGLE_CLIENT_SECRET,
  },
  stripe: {
    secretKey: process.env.STRIPE_SECRET_KEY,
    webhookSecret: process.env.STRIPE_WEBHOOK_SECRET,
  },
  cloudinary: {
    cloudName: process.env.CLOUDINARY_CLOUD_NAME,
    apiKey: process.env.CLOUDINARY_API_KEY,
    apiSecret: process.env.CLOUDINARY_API_SECRET,
  },
}

if (isProduction) {
  const required = ['MONGODB_URI', 'JWT_ACCESS_SECRET', 'WEB_APP_URL', 'API_PUBLIC_URL', 'STRIPE_SECRET_KEY', 'STRIPE_WEBHOOK_SECRET']
  const missing = required.filter((key) => !process.env[key])
  if (missing.length) throw new Error(`Missing required environment variables: ${missing.join(', ')}`)
  if (env.accessSecret.length < 32) throw new Error('JWT_ACCESS_SECRET must be at least 32 characters in production.')
  if (!env.webAppUrl.startsWith('https://') || !env.apiPublicUrl.startsWith('https://')) {
    throw new Error('WEB_APP_URL and API_PUBLIC_URL must use https in production.')
  }
}

if (!(env.taxRate >= 0 && env.taxRate < 1)) throw new Error('TAX_RATE must be a number between 0 and 1.')
