import crypto from 'node:crypto'
import { Router } from 'express'
import User from '../models/User.js'
import OAuthExchange from '../models/OAuthExchange.js'
import { env } from '../config/env.js'
import { asyncHandler } from '../utils/httpError.js'
import { hashToken } from '../utils/tokens.js'

const router = Router()
const STATE_COOKIE = 'lembro_oauth_state'

function safeEqual(a, b) {
  const left = Buffer.from(a)
  const right = Buffer.from(b)
  return left.length === right.length && crypto.timingSafeEqual(left, right)
}

router.get('/google', asyncHandler(async (request, response) => {
  const fail = (reason) => {
    response.clearCookie(STATE_COOKIE, { path: '/api/v1/auth/oauth' })
    response.redirect(`${env.webAppUrl}/auth/callback?error=${reason}`)
  }
  const { code, state, error } = request.query
  if (error) return fail('cancelled')
  const expected = request.cookies?.[STATE_COOKIE]
  if (typeof code !== 'string' || typeof state !== 'string' || typeof expected !== 'string' || !safeEqual(state, expected)) {
    return fail('invalid_state')
  }
  if (!env.google.clientId || !env.google.clientSecret) return fail('not_configured')

  try {
    const tokenResponse = await fetch('https://oauth2.googleapis.com/token', {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({
        code,
        client_id: env.google.clientId,
        client_secret: env.google.clientSecret,
        // Built from configuration, never from the incoming Host header.
        redirect_uri: `${env.apiPublicUrl}/api/v1/auth/oauth/google`,
        grant_type: 'authorization_code',
      }),
    })
    const tokens = await tokenResponse.json()
    if (!tokenResponse.ok || !tokens.access_token) return fail('failed')

    const profileResponse = await fetch('https://openidconnect.googleapis.com/v1/userinfo', {
      headers: { Authorization: `Bearer ${tokens.access_token}` },
    })
    const profile = await profileResponse.json()
    if (!profileResponse.ok || typeof profile.email !== 'string' || profile.email_verified !== true) return fail('unverified_email')

    const email = profile.email.toLowerCase()
    let user = await User.findOne({ email })
    if (!user) {
      user = await User.create({ name: String(profile.name || email.split('@')[0]).slice(0, 120), email, emailVerifiedAt: new Date() })
    } else if (!user.emailVerifiedAt) {
      // Someone may have pre-registered this address with a password they chose. Google has now proven
      // the real owner, so drop that password to stop it being used to take over the account.
      await User.updateOne({ _id: user._id }, { $set: { emailVerifiedAt: new Date() }, $unset: { passwordHash: 1 } })
    }
    if (user.status !== 'active') return fail('unavailable')

    const exchangeCode = crypto.randomBytes(32).toString('hex')
    await OAuthExchange.create({ codeHash: hashToken(exchangeCode), userId: user.id, expiresAt: new Date(Date.now() + 2 * 60 * 1000) })
    response.clearCookie(STATE_COOKIE, { path: '/api/v1/auth/oauth' })
    return response.redirect(`${env.webAppUrl}/auth/callback?code=${encodeURIComponent(exchangeCode)}`)
  } catch (callbackError) {
    console.error('Google OAuth callback failed', callbackError)
    return fail('failed')
  }
}))

export default router
