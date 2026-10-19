// Vercel entry point: the whole Express app runs as one serverless function.
// (src/server.js is for long-running hosts; it calls app.listen(), which Vercel can't use.)
import app from '../src/app.js'
import { drainWrites } from '../src/cache/cache.js'
import { connectRedis } from '../src/cache/redisClient.js'
import { connectDatabase } from '../src/config/db.js'

// Connections are opened once per warm function instance and reused by later requests.
let booting = null
function boot() {
  booting ||= Promise.all([connectDatabase(), connectRedis()]).catch((error) => {
    booting = null // let the next request try again instead of caching the failure
    throw error
  })
  return booting
}

export default async function handler(request, response) {
  try {
    await boot()
  } catch (error) {
    console.error('Startup failed:', error.message)
    response.statusCode = 503
    response.setHeader('Content-Type', 'application/json')
    response.end(JSON.stringify({ error: { code: 'SERVICE_UNAVAILABLE', message: 'The service is unavailable. Please try again shortly.' } }))
    return
  }
  // Stay alive until the response is finished and pending cache writes are flushed;
  // a serverless instance can be frozen as soon as the handler returns.
  await new Promise((resolve) => {
    response.once('close', resolve)
    app(request, response)
  })
  await drainWrites()
}
