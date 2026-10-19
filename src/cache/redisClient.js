import { env } from '../config/env.js'
import { logger, logLimited } from '../utils/logger.js'

// Owns the single Redis connection. The app never waits for Redis: it connects in the background,
// commands fail fast while disconnected (no offline queue), and callers treat "not ready" as a cache miss.
let client = null
let ready = false
const readyHooks = []

export function onRedisReady(hook) {
  readyHooks.push(hook)
}

export function isRedisReady() {
  return Boolean(client && ready)
}

export function getRedis() {
  return isRedisReady() ? client : null
}

// `createClient` can be injected (tests); otherwise the official `redis` package is loaded lazily so
// a missing install degrades to "no caching" instead of crashing the API.
export async function connectRedis({ createClient: injected } = {}) {
  if (client) return true
  if (!env.cache.enabled) {
    logger.info('Redis caching is disabled (set REDIS_URL to enable it)')
    return false
  }
  let createClient = injected
  if (!createClient) {
    try {
      ;({ createClient } = await import('redis'))
    } catch {
      logger.warn('The "redis" package is not installed; running without cache. Run `npm install` in backend/.')
      return false
    }
  }

  client = createClient({
    url: env.cache.redisUrl,
    // Fail commands immediately while disconnected instead of queueing them (a queue would stall requests).
    disableOfflineQueue: true,
    socket: {
      connectTimeout: env.cache.connectTimeoutMs,
      reconnectStrategy: (retries) => Math.min(100 * 2 ** Math.min(retries, 6), 5000),
    },
  })
  // An unhandled 'error' event would crash the process, so it must always be listened for.
  client.on('error', (error) => {
    ready = false
    logLimited('redis-error', 'warn', 'Redis error', { error: error.message })
  })
  client.on('ready', () => {
    ready = true
    logger.info('Redis connected')
    readyHooks.forEach((hook) => hook())
  })
  client.on('reconnecting', () => {
    ready = false
    logLimited('redis-reconnecting', 'warn', 'Redis reconnecting; serving without cache')
  })
  client.on('end', () => { ready = false })
  client.connect().catch((error) => logLimited('redis-connect', 'warn', 'Redis connection failed; serving without cache', { error: error.message }))
  return true
}

export async function closeRedis() {
  if (!client) return
  const closing = client
  client = null
  ready = false
  try {
    await Promise.race([closing.quit(), new Promise((_, reject) => setTimeout(() => reject(new Error('quit timeout')), 1000).unref())])
  } catch {
    await closing.disconnect?.().catch(() => {})
  }
}
