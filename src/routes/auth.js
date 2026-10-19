import bcrypt from 'bcryptjs'
import crypto from 'node:crypto'
import { Router } from 'express'
import User from '../models/User.js'
import OAuthExchange from '../models/OAuthExchange.js'
import { consumeAuthToken, createAuthToken, hashToken } from '../utils/tokens.js'
import { frontendLink, linkEmail, sendEmail } from '../utils/mailer.js'
import { env } from '../config/env.js'
import { HttpError, asyncHandler } from '../utils/httpError.js'
import { parse, v } from '../utils/validation.js'
import { requireAuth, signAccessToken } from '../middleware/auth.js'
import { authLimiter } from '../middleware/rateLimits.js'
import {
  clearRefreshCookie, issueRefreshSession, revokeAllSessions, revokeSession, rotateRefreshSession, setRefreshCookie,
} from '../services/sessions.js'

const router = Router()

const HOUR = 60 * 60 * 1000
const MAX_FAILED_LOGINS = 5
const LOCK_MS = 15 * 60 * 1000
// Compared against when the email is unknown so response time doesn't reveal which emails exist.
const DUMMY_HASH = bcrypt.hashSync('lembro-timing-equaliser', 12)

const emailSchema = { email: v.email() }
const tokenSchema = { token: v.string({ min: 20, max: 200 }) }

function googleConfigured() {
  return Boolean(env.google.clientId && env.google.clientSecret)
}

async function startSession(request, response, user) {
  setRefreshCookie(response, await issueRefreshSession(user, request))
  return { user: user.toPublic(), accessToken: signAccessToken(user) }
}

async function sendVerificationEmail(user) {
  const token = await createAuthToken(user.id, 'email_verification', 24 * HOUR)
  await sendEmail({
    to: user.email,
    subject: 'Verify your Lembro email',
    ...linkEmail({
      heading: 'Verify your email address',
      intro: `Hi ${user.name}, confirm your email address to finish creating your Lembro account.`,
      linkText: 'Verify email',
      url: frontendLink('/auth/verify-email', token),
    }),
  })
}

// Email problems must never change the HTTP response (that would leak whether an account exists).
async function bestEffort(task) {
  try {
    await task()
  } catch (error) {
    console.error('Email delivery failed:', error.message)
  }
}

router.post('/register', authLimiter, asyncHandler(async (request, response) => {
  const { name, email, password } = parse({ name: v.string({ min: 2, max: 120 }), ...emailSchema, password: v.password() }, request.body)
  // Hash first so both branches take roughly the same time.
  const passwordHash = await bcrypt.hash(password, 12)
  const reply = { message: 'Almost there! If this email can be registered, we have sent a verification link to it.' }

  const existing = await User.findOne({ email })
  if (existing) {
    if (!existing.emailVerifiedAt) {
      await bestEffort(() => sendVerificationEmail(existing))
    } else {
      await bestEffort(() => sendEmail({
        to: email,
        subject: 'You already have a Lembro account',
        ...linkEmail({
          heading: 'You already have an account',
          intro: 'Someone tried to register with this email address. If it was you, sign in or reset your password instead.',
          linkText: 'Go to sign in',
          url: `${env.webAppUrl}/auth/login`,
        }),
      }))
    }
    return response.status(201).json(reply)
  }

  let user
  try {
    user = await User.create({ name, email, passwordHash })
  } catch (error) {
    if (error?.code === 11000) return response.status(201).json(reply)
    throw error
  }
  await bestEffort(() => sendVerificationEmail(user))
  return response.status(201).json(reply)
}))

router.post('/login', authLimiter, asyncHandler(async (request, response) => {
  const { email, password } = parse({ ...emailSchema, password: v.string({ min: 1, max: 200 }) }, request.body)
  const user = await User.findOne({ email }).select('+passwordHash +failedLoginAttempts +lockUntil')
  const locked = Boolean(user?.lockUntil && user.lockUntil > new Date())
  const valid = await bcrypt.compare(password, user?.passwordHash || DUMMY_HASH)

  if (!user || !user.passwordHash || locked || !valid) {
    if (user && !locked) {
      const updated = await User.findByIdAndUpdate(user._id, { $inc: { failedLoginAttempts: 1 } }, { new: true }).select('+failedLoginAttempts')
      if (updated.failedLoginAttempts >= MAX_FAILED_LOGINS) {
        await User.updateOne({ _id: user._id }, { $set: { lockUntil: new Date(Date.now() + LOCK_MS), failedLoginAttempts: 0 } })
      }
    }
    throw new HttpError(401, 'INVALID_CREDENTIALS', 'Email or password is incorrect, or the account is temporarily locked after repeated failed attempts.')
  }
  if (user.status !== 'active') throw new HttpError(403, 'ACCOUNT_UNAVAILABLE', 'This account is unavailable.')
  if (!user.emailVerifiedAt) throw new HttpError(403, 'EMAIL_NOT_VERIFIED', 'Verify your email before signing in.')

  await User.updateOne({ _id: user._id }, { $set: { lastLoginAt: new Date(), failedLoginAttempts: 0 }, $unset: { lockUntil: 1 } })
  response.json(await startSession(request, response, user))
}))

// POST (not GET) so link-preview bots and email scanners cannot burn the one-time token.
router.post('/verify-email', authLimiter, asyncHandler(async (request, response) => {
  const { token: rawToken } = parse(tokenSchema, request.body)
  const token = await consumeAuthToken(rawToken, 'email_verification')
  if (!token) throw new HttpError(400, 'INVALID_TOKEN', 'The verification link is invalid or has expired.')
  const user = await User.findByIdAndUpdate(token.userId, { emailVerifiedAt: new Date() }, { new: true })
  if (!user) throw new HttpError(404, 'USER_NOT_FOUND', 'The account could not be found.')
  response.json({ message: 'Email verified successfully. You can now sign in.' })
}))

router.post('/resend-verification', authLimiter, asyncHandler(async (request, response) => {
  const { email } = parse(emailSchema, request.body)
  const user = await User.findOne({ email })
  if (user && !user.emailVerifiedAt && user.status === 'active') await bestEffort(() => sendVerificationEmail(user))
  response.json({ message: 'If the account exists and needs verification, a new email has been sent.' })
}))

router.post('/forgot-password', authLimiter, asyncHandler(async (request, response) => {
  const { email } = parse(emailSchema, request.body)
  const user = await User.findOne({ email, status: 'active' })
  if (user) {
    await bestEffort(async () => {
      const token = await createAuthToken(user.id, 'password_reset', HOUR)
      await sendEmail({
        to: user.email,
        subject: 'Reset your Lembro password',
        ...linkEmail({
          heading: 'Reset your password',
          intro: 'We received a request to reset your password. This link works for one hour.',
          linkText: 'Choose a new password',
          url: frontendLink('/auth/reset-password', token),
        }),
      })
    })
  }
  response.json({ message: 'If an account exists for that email, reset instructions have been sent.' })
}))

router.post('/reset-password', authLimiter, asyncHandler(async (request, response) => {
  const { token: rawToken, password } = parse({ ...tokenSchema, password: v.password() }, request.body)
  const token = await consumeAuthToken(rawToken, 'password_reset')
  if (!token) throw new HttpError(400, 'INVALID_TOKEN', 'The reset link is invalid or has expired.')
  const passwordHash = await bcrypt.hash(password, 12)
  const user = await User.findByIdAndUpdate(
    token.userId,
    // Receiving the email proves ownership, so this also verifies the address and clears any lockout.
    { $set: { passwordHash, failedLoginAttempts: 0, emailVerifiedAt: new Date() }, $unset: { lockUntil: 1 } },
    { new: true },
  )
  if (!user) throw new HttpError(404, 'USER_NOT_FOUND', 'The account could not be found.')
  await revokeAllSessions(user._id)
  response.json({ message: 'Password reset successfully. Please sign in with your new password.' })
}))

router.get('/oauth/google/start', asyncHandler(async (request, response) => {
  if (!googleConfigured()) throw new HttpError(503, 'OAUTH_NOT_CONFIGURED', 'Google sign-in is not configured.')
  const state = crypto.randomBytes(24).toString('hex')
  response.cookie('lembro_oauth_state', state, {
    httpOnly: true, secure: env.isProduction, sameSite: 'lax', maxAge: 10 * 60 * 1000, path: '/api/v1/auth/oauth',
  })
  const params = new URLSearchParams({
    client_id: env.google.clientId,
    redirect_uri: `${env.apiPublicUrl}/api/v1/auth/oauth/google`,
    response_type: 'code',
    scope: 'openid email profile',
    state,
    prompt: 'select_account',
  })
  response.redirect(`https://accounts.google.com/o/oauth2/v2/auth?${params}`)
}))

router.post('/oauth/callback', authLimiter, asyncHandler(async (request, response) => {
  const { code } = parse({ code: v.string({ min: 32, max: 128 }) }, request.body)
  const exchange = await OAuthExchange.findOneAndDelete({ codeHash: hashToken(code), expiresAt: { $gt: new Date() } })
  if (!exchange) throw new HttpError(400, 'INVALID_OAUTH_CODE', 'The sign-in code is invalid or has expired.')
  const user = await User.findById(exchange.userId)
  if (!user || user.status !== 'active') throw new HttpError(401, 'ACCOUNT_UNAVAILABLE', 'The account is unavailable.')
  response.json(await startSession(request, response, user))
}))

router.post('/refresh', asyncHandler(async (request, response) => {
  const rawToken = request.cookies?.[env.refreshCookieName]
  if (typeof rawToken !== 'string' || !rawToken) throw new HttpError(401, 'UNAUTHORIZED', 'A refresh session is required.')
  try {
    const { user, token } = await rotateRefreshSession(rawToken, request)
    setRefreshCookie(response, token)
    response.json({ user: user.toPublic(), accessToken: signAccessToken(user) })
  } catch (error) {
    if (error.code !== 'REFRESH_IN_PROGRESS') clearRefreshCookie(response)
    throw error
  }
}))

// Works without a valid access token: an expired access token must not stop someone signing out.
router.post('/logout', asyncHandler(async (request, response) => {
  const rawToken = request.cookies?.[env.refreshCookieName]
  if (typeof rawToken === 'string' && rawToken) await revokeSession(rawToken)
  clearRefreshCookie(response)
  response.status(204).end()
}))

router.post('/logout-all', requireAuth, asyncHandler(async (request, response) => {
  await revokeAllSessions(request.user._id)
  clearRefreshCookie(response)
  response.status(204).end()
}))

router.get('/me', requireAuth, asyncHandler(async (request, response) => {
  const user = await User.findById(request.user._id).select('+passwordHash')
  response.json({ user: user.toPublic() })
}))

router.patch('/me', requireAuth, asyncHandler(async (request, response) => {
  const changes = parse({ name: v.string({ min: 2, max: 120 }) }, request.body, { partial: true })
  const user = await User.findByIdAndUpdate(request.user._id, { $set: changes }, { new: true }).select('+passwordHash')
  response.json({ user: user.toPublic() })
}))

router.post('/change-password', authLimiter, requireAuth, asyncHandler(async (request, response) => {
  const { currentPassword, newPassword } = parse({
    currentPassword: v.optional(v.string({ min: 1, max: 200 })),
    newPassword: v.password(),
  }, request.body)
  const user = await User.findById(request.user._id).select('+passwordHash')
  // Accounts created through Google have no password yet and may set one without a current password.
  if (user.passwordHash && !(currentPassword && await bcrypt.compare(currentPassword, user.passwordHash))) {
    throw new HttpError(400, 'INVALID_CURRENT_PASSWORD', 'Your current password is incorrect.')
  }
  user.passwordHash = await bcrypt.hash(newPassword, 12)
  await user.save()
  await revokeAllSessions(user._id)
  // Keep this device signed in with a fresh session; every other device must sign in again.
  response.json({ message: 'Password updated.', ...(await startSession(request, response, user)) })
}))

export default router
