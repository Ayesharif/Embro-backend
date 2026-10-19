import { buildKey, isCachingEnabled, joinOrLead, lookup, store, waitForLeader } from './cache.js'

function sendCached(response, text, label) {
  response.set('X-Cache', label)
  return response.type('application/json').send(text)
}

// What makes two requests "the same" for caching purposes.
//  * Only the query parameters listed in `allowedQuery` count. Anything else is ignored, so a client
//    can't flood Redis with endless unique keys by appending random parameters.
//  * scope 'public'  -> same response for everyone (catalogue data)
//  * scope 'staff'   -> admin data; must already have passed requireAuth/requireRole, and an
//                       unauthenticated request is never served from cache
//  * scope 'user'    -> keyed by the signed-in user's id, so one user can never receive another's data
function fingerprint(request, { allowedQuery, parts, scope }) {
  const query = allowedQuery
    .filter((name) => request.query[name] !== undefined)
    .sort()
    .map((name) => [name, String(request.query[name])])
  return JSON.stringify({ scope, user: scope === 'user' ? request.user.id : undefined, path: parts ? parts(request) : '', query })
}

// Express middleware: serves GET responses from Redis, otherwise runs the real handler and stores
// its 200 JSON response. Put it AFTER any authentication/authorisation middleware on the route.
export function cacheResponse({ name, namespaces, ttl, allowedQuery = [], parts, scope = 'public' }) {
  return async function cacheMiddleware(request, response, next) {
    if (!isCachingEnabled() || request.method !== 'GET') return next()
    if ((scope === 'staff' || scope === 'user') && !request.user) return next()

    try {
      const key = await buildKey(name, namespaces, fingerprint(request, { allowedQuery, parts, scope }))
      if (!key) {
        response.set('X-Cache', 'BYPASS')
        return next()
      }

      const flight = joinOrLead(key)
      if (!flight.leader) {
        const text = await waitForLeader(flight.wait)
        return text ? sendCached(response, text, 'HIT') : next()
      }

      const hit = await lookup(key, name)
      if (hit !== null) {
        flight.finish(hit)
        return sendCached(response, hit, 'HIT')
      }

      // We are the one request that queries the database; capture its successful JSON reply.
      response.once('close', () => flight.finish(null))
      const originalJson = response.json.bind(response)
      response.json = (body) => {
        response.json = originalJson
        if (response.statusCode !== 200) {
          flight.finish(null) // errors and non-200 replies are never cached
          return originalJson(body)
        }
        let text
        try {
          text = JSON.stringify(body)
        } catch {
          flight.finish(null)
          return originalJson(body)
        }
        flight.finish(text)
        store(key, text, ttl, name)
        response.set('X-Cache', 'MISS')
        return response.type('application/json').send(text)
      }
      return next()
    } catch {
      // The cache layer itself must never break a request.
      return next()
    }
  }
}
