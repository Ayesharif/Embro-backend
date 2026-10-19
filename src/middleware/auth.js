import jwt from 'jsonwebtoken'
import User from '../models/User.js'
import { env } from '../config/env.js'
import { HttpError, asyncHandler } from '../utils/httpError.js'

const ISSUER = 'lembro-api'

// Roles allowed to use each area of the admin API. Keep these narrow: "support" and "warehouse"
// staff must never be able to edit the catalogue, users, discounts or refunds.
export const ROLE_GROUPS = {
  catalog: ['admin', 'super_admin'],
  users: ['admin', 'super_admin'],
  finance: ['admin', 'super_admin'],
  orders: ['admin', 'super_admin', 'warehouse', 'support'],
  fulfillment: ['admin', 'super_admin', 'warehouse'],
  inbox: ['admin', 'super_admin', 'support'],
}

export function signAccessToken(user) {
  return jwt.sign({ sub: user.id, role: user.role }, env.accessSecret, {
    algorithm: 'HS256',
    expiresIn: env.accessExpiresIn,
    issuer: ISSUER,
  })
}

function bearerToken(request) {
  const header = request.get('authorization')
  return header?.startsWith('Bearer ') ? header.slice(7).trim() : null
}

async function userFromToken(token) {
  let payload
  try {
    payload = jwt.verify(token, env.accessSecret, { algorithms: ['HS256'], issuer: ISSUER })
  } catch {
    throw new HttpError(401, 'INVALID_TOKEN', 'The access token is invalid or expired.')
  }
  // The role is always read from the database so demotions/suspensions apply immediately.
  const user = await User.findById(payload.sub)
  if (!user || user.status !== 'active') throw new HttpError(401, 'UNAUTHORIZED', 'The account is unavailable.')
  return user
}

export const requireAuth = asyncHandler(async (request, response, next) => {
  const token = bearerToken(request)
  if (!token) throw new HttpError(401, 'UNAUTHORIZED', 'Authentication is required.')
  request.user = await userFromToken(token)
  next()
})

// Attaches req.user when a valid token is present; otherwise carries on as a guest.
export const optionalAuth = asyncHandler(async (request, response, next) => {
  const token = bearerToken(request)
  if (token) {
    try {
      request.user = await userFromToken(token)
    } catch {
      request.user = undefined
    }
  }
  next()
})

export function requireRole(...roles) {
  return (request, response, next) => {
    if (!request.user || !roles.includes(request.user.role)) {
      next(new HttpError(403, 'FORBIDDEN', 'You do not have permission to perform this action.'))
      return
    }
    next()
  }
}
