import crypto from 'node:crypto'
import { env } from '../config/env.js'
import { logger, logLimited } from '../utils/logger.js'
import { getRedis, isRedisReady, onRedisReady } from './redisClient.js'

// ---------------------------------------------------------------------------
// Design notes
//  * Invalidation uses namespace *versions*: every cache key embeds the current version of the
//    namespaces it depends on, and invalidating a namespace is one atomic INCR. No SCAN/KEYS, no
//    deleting lists of keys, and a slow request that read old data can only ever write under the
//    old version, which nobody reads again - so stale data cannot be re-introduced by a race.
//  * Every Redis call has a timeout and is fail-open: any error behaves like a cache miss.
//  * Identical concurrent misses on one server are coalesced into a single database query.
// ---------------------------------------------------------------------------

const stats = { hits: 0, misses: 0, writes: 0, bypassed: 0, errors: 0, coalesced: 0, tooLarge: 0, invalidations: 0, invalidationFailures: 0, byName: {} }
const flights = new Map()
const pendingWrites = new Set()
const pendingInvalidations = new Set()
const FOLLOWER_WAIT_MS = 5000

const bump = (name, field) => {
  stats[field] += 1
  const entry = (stats.byName[name] ||= { hits: 0, misses: 0 })
  if (field === 'hits' || field === 'misses') entry[field] += 1
}

export function isCachingEnabled() {
  return env.cache.enabled
}

export function getCacheStats() {
  const lookups = stats.hits + stats.misses
  return {
    enabled: env.cache.enabled,
    connected: isRedisReady(),
    ...stats,
    hitRatio: lookups ? Math.round((stats.hits / lookups) * 1000) / 1000 : null,
  }
}

export function resetCacheStats() {
  Object.assign(stats, { hits: 0, misses: 0, writes: 0, bypassed: 0, errors: 0, coalesced: 0, tooLarge: 0, invalidations: 0, invalidationFailures: 0, byName: {} })
}

function withTimeout(promise) {
  let timer
  const timeout = new Promise((_, reject) => { timer = setTimeout(() => reject(new Error('Redis command timed out')), env.cache.commandTimeoutMs) })
  return Promise.race([promise, timeout]).finally(() => clearTimeout(timer))
}

// Runs one Redis command. Never throws: returns { ok: false } when Redis is down, slow or erroring.
async function command(run) {
  const redis = getRedis()
  if (!redis) {
    stats.bypassed += 1
    return { ok: false }
  }
  try {
    return { ok: true, value: await withTimeout(run(redis)) }
  } catch (error) {
    stats.errors += 1
    logLimited('cache-command', 'warn', 'Redis command failed; falling back to the database', { error: error.message })
    return { ok: false }
  }
}

const versionKey = (namespace) => `${env.cache.prefix}:ns:${namespace}`

// Reads the current version of each namespace. A missing version (fresh Redis, or evicted) is
// initialised to a unique token so entries written under any earlier version can never match.
async function readVersions(namespaces) {
  const keys = namespaces.map(versionKey)
  let result = await command((redis) => redis.mGet(keys))
  if (!result.ok) return null
  if (result.value.some((value) => value === null)) {
    for (let index = 0; index < keys.length; index += 1) {
      if (result.value[index] === null) {
        const init = await command((redis) => redis.set(keys[index], String(Date.now()), { NX: true }))
        if (!init.ok) return null
      }
    }
    result = await command((redis) => redis.mGet(keys))
    if (!result.ok || result.value.some((value) => value === null)) return null
  }
  return result.value
}

// Builds the cache key, or null when Redis can't be used right now (caller then skips the cache).
export async function buildKey(name, namespaces, fingerprint = '') {
  const versions = await readVersions(namespaces)
  if (!versions) return null
  const digest = fingerprint ? crypto.createHash('sha1').update(fingerprint).digest('base64url').slice(0, 22) : 'all'
  return `${env.cache.prefix}:${name}:${versions.join('.')}:${digest}`
}

export async function lookup(key, name) {
  const result = await command((redis) => redis.get(key))
  if (!result.ok) return null
  if (result.value === null) {
    bump(name, 'misses')
    if (env.cache.debug) logger.debug('cache miss', { name })
    return null
  }
  bump(name, 'hits')
  if (env.cache.debug) logger.debug('cache hit', { name })
  return result.value
}

// Fire-and-forget write (the response is never delayed by it). TTL gets +-10% jitter so entries
// created together don't all expire - and hit the database - at the same instant.
export function store(key, text, ttlSeconds, name) {
  if (Buffer.byteLength(text) > env.cache.maxValueBytes) {
    bump(name, 'tooLarge')
    return
  }
  const ttl = Math.max(1, Math.round(ttlSeconds * (0.9 + Math.random() * 0.2)))
  const write = command((redis) => redis.set(key, text, { EX: ttl })).then((result) => {
    if (result.ok) bump(name, 'writes')
  })
  pendingWrites.add(write)
  write.finally(() => pendingWrites.delete(write))
}

export async function drainWrites() {
  await Promise.allSettled([...pendingWrites])
}

// ---- single-flight: concurrent identical misses share one database query ----

export function joinOrLead(key) {
  const existing = flights.get(key)
  if (existing) return { leader: false, wait: existing.promise }
  let resolve
  const promise = new Promise((done) => { resolve = done })
  const flight = { promise, done: false }
  flights.set(key, flight)
  return {
    leader: true,
    finish(text) {
      if (flight.done) return
      flight.done = true
      flights.delete(key)
      resolve(text ?? null)
    },
  }
}

export async function waitForLeader(wait) {
  let timer
  const timeout = new Promise((resolve) => { timer = setTimeout(() => resolve(null), FOLLOWER_WAIT_MS) })
  const text = await Promise.race([wait, timeout]).finally(() => clearTimeout(timer))
  if (text) bump('coalesced', 'coalesced')
  return text
}

// Read-through helper for code that isn't a plain Express response (returns the loader's value).
export async function cached({ name, namespaces, ttl, fingerprint = '' }, loader) {
  if (!isCachingEnabled()) return loader()
  const key = await buildKey(name, namespaces, fingerprint)
  if (!key) return loader()
  const flight = joinOrLead(key)
  if (!flight.leader) {
    const text = await waitForLeader(flight.wait)
    return text ? JSON.parse(text) : loader()
  }
  try {
    const hit = await lookup(key, name)
    if (hit !== null) {
      flight.finish(hit)
      return JSON.parse(hit)
    }
    const value = await loader()
    const text = value === undefined ? null : JSON.stringify(value)
    flight.finish(text)
    if (text) store(key, text, ttl, name)
    return value
  } catch (error) {
    flight.finish(null)
    throw error
  }
}

// ---- invalidation ----

// Call this only AFTER the database write succeeded. It never throws: if Redis is down the
// namespaces are remembered and invalidated as soon as Redis reconnects.
export async function invalidate(namespaces) {
  stats.invalidations += 1
  const result = await command((redis) => Promise.all(namespaces.map((namespace) => redis.incr(versionKey(namespace)))))
  if (!result.ok) {
    stats.invalidationFailures += 1
    namespaces.forEach((namespace) => pendingInvalidations.add(namespace))
    if (env.cache.enabled) logLimited('cache-invalidate', 'warn', 'Cache invalidation failed; it will be retried when Redis reconnects', { namespaces })
  } else if (env.cache.debug) {
    logger.debug('cache invalidated', { namespaces })
  }
}

onRedisReady(() => {
  if (!pendingInvalidations.size) return
  const queued = [...pendingInvalidations]
  pendingInvalidations.clear()
  invalidate(queued)
})
