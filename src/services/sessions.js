import crypto from 'node:crypto'
import RefreshSession from '../models/RefreshSession.js'
import User from '../models/User.js'
import { env } from '../config/env.js'
import { HttpError } from '../utils/httpError.js'
import { createRawToken, hashToken } from '../utils/tokens.js'

const REUSE_GRACE_MS = 10 * 1000

function cookieOptions() {
  return {
    httpOnly: true,
    secure: env.isProduction || env.cookieSameSite === 'none',
    sameSite: env.cookieSameSite,
    // The cookie is only ever needed by the auth endpoints, so it is not sent anywhere else.
    path: '/api/v1/auth',
  }
}

export function setRefreshCookie(response, token) {
  response.cookie(env.refreshCookieName, token, { ...cookieOptions(), maxAge: env.refreshTtlDays * 24 * 60 * 60 * 1000 })
}

export function clearRefreshCookie(response) {
  response.clearCookie(env.refreshCookieName, cookieOptions())
}

export async function issueRefreshSession(user, request, family = crypto.randomUUID()) {
  const token = createRawToken()
  await RefreshSession.create({
    user: user._id,
    family,
    tokenHash: hashToken(token),
    expiresAt: new Date(Date.now() + env.refreshTtlDays * 24 * 60 * 60 * 1000),
    userAgent: request.get('user-agent')?.slice(0, 300),
  })
  return token
}

// Exchanges a refresh token for a new one. Each token works exactly once; presenting an already
// used token outside the short grace window is treated as theft and revokes the whole family.
export async function rotateRefreshSession(rawToken, request) {
  const tokenHash = hashToken(rawToken)
  const claimed = await RefreshSession.findOneAndUpdate(
    { tokenHash, usedAt: { $exists: false }, expiresAt: { $gt: new Date() } },
    { $set: { usedAt: new Date() } },
  )
  if (!claimed) {
    const known = await RefreshSession.findOne({ tokenHash })
    if (known?.usedAt) {
      if (Date.now() - known.usedAt.getTime() <= REUSE_GRACE_MS) {
        // Two tabs refreshing at once: the other request already rotated the token and set a new cookie.
        throw new HttpError(401, 'REFRESH_IN_PROGRESS', 'The session was just refreshed. Retry shortly.')
      }
      await RefreshSession.deleteMany({ family: known.family })
    }
    throw new HttpError(401, 'INVALID_REFRESH_TOKEN', 'The refresh session is invalid or expired.')
  }
  const user = await User.findById(claimed.user)
  if (!user || user.status !== 'active') {
    await RefreshSession.deleteMany({ family: claimed.family })
    throw new HttpError(401, 'UNAUTHORIZED', 'The account is unavailable.')
  }
  const token = await issueRefreshSession(user, request, claimed.family)
  return { user, token }
}

export async function revokeSession(rawToken) {
  const session = await RefreshSession.findOne({ tokenHash: hashToken(rawToken) })
  if (session) await RefreshSession.deleteMany({ family: session.family })
}

export function revokeAllSessions(userId) {
  return RefreshSession.deleteMany({ user: userId })
}
