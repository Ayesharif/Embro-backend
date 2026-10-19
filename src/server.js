import mongoose from 'mongoose'
import app from './app.js'
import { drainWrites } from './cache/cache.js'
import { closeRedis, connectRedis } from './cache/redisClient.js'
import { connectDatabase } from './config/db.js'
import { env } from './config/env.js'

await connectDatabase()
// Redis connects in the background: the API starts (and keeps serving from MongoDB) even if it is down.
await connectRedis()
const server = app.listen(env.port, () => {
  console.log(`Lembro API listening on http://localhost:${env.port} (${env.nodeEnv})`)
})

async function shutdown(signal) {
  console.log(`${signal} received, shutting down...`)
  server.close(async () => {
    await drainWrites()
    await closeRedis()
    await mongoose.disconnect()
    process.exit(0)
  })
  setTimeout(() => process.exit(1), 10_000).unref()
}
process.on('SIGTERM', () => shutdown('SIGTERM'))
process.on('SIGINT', () => shutdown('SIGINT'))
process.on('unhandledRejection', (reason) => console.error('Unhandled rejection:', reason))
