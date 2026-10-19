import mongoose from 'mongoose'
import { env } from './env.js'

export async function connectDatabase() {
  if (!env.mongoUri) throw new Error('MONGODB_URI is not configured')
  mongoose.set('strictQuery', true)
  // Serverless platforms start many instances; a small pool per instance keeps the total under Atlas' connection limit.
  const maxPoolSize = Number(process.env.MONGODB_MAX_POOL_SIZE) || (process.env.VERCEL ? 5 : 10)
  await mongoose.connect(env.mongoUri, { maxPoolSize })
  console.log('MongoDB connected')
}

export async function disconnectDatabase() {
  await mongoose.disconnect()
}
