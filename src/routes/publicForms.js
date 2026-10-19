import { Router } from 'express'
import ContactMessage from '../models/ContactMessage.js'
import Subscriber from '../models/Subscriber.js'
import { asyncHandler } from '../utils/httpError.js'
import { parse, v } from '../utils/validation.js'
import { publicFormLimiter } from '../middleware/rateLimits.js'

const router = Router()

router.post('/contact', publicFormLimiter, asyncHandler(async (request, response) => {
  const input = parse({
    name: v.string({ min: 2, max: 120 }),
    email: v.email(),
    phone: v.optional(v.string({ min: 0, max: 40 })),
    message: v.string({ min: 10, max: 5000 }),
    // Honeypot: hidden from people, filled in by naive bots. Pretend it worked and drop it.
    website: v.optional(v.string({ min: 0, max: 200 })),
  }, request.body)
  const { website, ...fields } = input
  if (!website) await ContactMessage.create(fields)
  response.status(201).json({ message: 'Thanks, your message has been sent.' })
}))

router.post('/newsletter', publicFormLimiter, asyncHandler(async (request, response) => {
  const { email } = parse({ email: v.email() }, request.body)
  await Subscriber.updateOne({ email }, { $setOnInsert: { email, source: 'footer' } }, { upsert: true })
  // Identical answer whether or not the address was already subscribed.
  response.status(201).json({ message: 'Thanks for subscribing!' })
}))

export default router
