import crypto from 'node:crypto'
import { Router } from 'express'
import { env } from '../config/env.js'
import { ROLE_GROUPS, requireAuth, requireRole } from '../middleware/auth.js'
import { HttpError } from '../utils/httpError.js'
import { parse, v } from '../utils/validation.js'

const router = Router()
const ALLOWED_FORMATS = 'jpg,jpeg,png,webp,avif'

router.post('/signature', requireAuth, requireRole(...ROLE_GROUPS.catalog), (request, response) => {
  const { cloudName, apiKey, apiSecret } = env.cloudinary
  if (!cloudName || !apiKey || !apiSecret) throw new HttpError(503, 'CLOUDINARY_NOT_CONFIGURED', 'Image uploads are not configured.')
  const { folder = 'lembro' } = parse({ folder: v.optional(v.string({ min: 1, max: 60, pattern: /^lembro(\/[a-z0-9_-]+)*$/ })) }, request.body ?? {})
  const timestamp = Math.floor(Date.now() / 1000)
  // Parameters must be signed in alphabetical order. Restricting formats here means the
  // signature itself rejects non-image uploads.
  const toSign = `allowed_formats=${ALLOWED_FORMATS}&folder=${folder}&timestamp=${timestamp}`
  const signature = crypto.createHash('sha1').update(toSign + apiSecret).digest('hex')
  response.json({ cloudName, apiKey, timestamp, folder, allowedFormats: ALLOWED_FORMATS, signature })
})

export default router
