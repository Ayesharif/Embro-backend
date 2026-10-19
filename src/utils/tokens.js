import crypto from 'node:crypto'
import AuthToken from '../models/AuthToken.js'

export function createRawToken() {
  return crypto.randomBytes(32).toString('hex')
}

export function hashToken(token) {
  return crypto.createHash('sha256').update(token).digest('hex')
}

// Creating a new token of a type invalidates older ones of the same type for that user.
export async function createAuthToken(userId, type, lifetimeMs) {
  await AuthToken.deleteMany({ userId, type })
  const rawToken = createRawToken()
  await AuthToken.create({
    userId,
    type,
    tokenHash: hashToken(rawToken),
    expiresAt: new Date(Date.now() + lifetimeMs),
  })
  return rawToken
}

export async function consumeAuthToken(rawToken, type) {
  return AuthToken.findOneAndDelete({
    tokenHash: hashToken(rawToken),
    type,
    expiresAt: { $gt: new Date() },
  })
}
