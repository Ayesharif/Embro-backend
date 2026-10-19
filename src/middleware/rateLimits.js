import rateLimit from 'express-rate-limit'

function limiter(windowMs, limit, message) {
  return rateLimit({
    windowMs,
    limit,
    standardHeaders: true,
    legacyHeaders: false,
    message: { error: { code: 'RATE_LIMITED', message } },
  })
}

const minutes = (count) => count * 60 * 1000

export const globalLimiter = limiter(minutes(15), 600, 'Too many requests. Please slow down and try again shortly.')
// Credential endpoints: guessing passwords or spamming emails is throttled hard.
export const authLimiter = limiter(minutes(15), 20, 'Too many attempts. Please wait a few minutes and try again.')
// Anonymous write endpoints (contact form, newsletter).
export const publicFormLimiter = limiter(minutes(60), 10, 'Too many submissions. Please try again later.')
