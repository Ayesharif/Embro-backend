import { Router } from 'express'
import Product from '../models/Product.js'
import { asyncHandler, HttpError } from '../utils/httpError.js'
import { parse, parseId, v } from '../utils/validation.js'
import { optionalAuth, requireAuth } from '../middleware/auth.js'
import { cartIdentity, cartView, loadCart, MAX_LINE_QUANTITY, mergeGuestCart } from '../services/cart.js'

const router = Router()
router.use(optionalAuth)

const quantity = v.integer({ min: 1, max: MAX_LINE_QUANTITY })

async function respond(request, response, status = 200) {
  const cart = await loadCart(cartIdentity(request))
  response.status(status).json({ cart: cartView(cart) })
}

router.get('/', asyncHandler(async (request, response) => {
  const identity = cartIdentity(request, { required: false })
  const cart = identity ? await loadCart(identity, { create: false }) : null
  response.json({ cart: cartView(cart) })
}))

router.post('/items', asyncHandler(async (request, response) => {
  const identity = cartIdentity(request)
  const input = parse({ productId: v.objectId(), variantId: v.objectId(), quantity: v.optional(quantity) }, request.body)
  const wanted = input.quantity ?? 1
  const product = await Product.findOne({ _id: input.productId, status: 'published' })
  if (!product) throw new HttpError(404, 'PRODUCT_NOT_FOUND', 'Product not found.')
  const variant = product.variants.id(input.variantId)
  if (!variant || variant.status !== 'active') throw new HttpError(400, 'INVALID_VARIANT', 'That option is not available.')
  const available = variant.stock

  const cart = await loadCart(identity)
  const existing = cart.items.find((item) => item.product && String(item.product._id) === input.productId && String(item.variantId || '') === input.variantId)
  const total = (existing?.quantity || 0) + wanted
  if (total > available) throw new HttpError(409, 'INSUFFICIENT_STOCK', available ? `Only ${available} in stock.` : 'This item is out of stock.')
  if (total > MAX_LINE_QUANTITY) throw new HttpError(409, 'QUANTITY_LIMIT', `You can order at most ${MAX_LINE_QUANTITY} of one item.`)
  if (existing) existing.quantity = total
  else cart.items.push({ product: input.productId, variantId: input.variantId, quantity: wanted })
  await cart.save()
  await respond(request, response, 201)
}))

router.patch('/items/:itemId', asyncHandler(async (request, response) => {
  const itemId = parseId(request.params.itemId, 'cart item id')
  const { quantity: next } = parse({ quantity }, request.body)
  const cart = await loadCart(cartIdentity(request))
  const item = cart.items.id(itemId)
  if (!item) throw new HttpError(404, 'CART_ITEM_NOT_FOUND', 'Cart item not found.')
  const product = item.product
  const variant = item.variantId ? product?.variants.id(item.variantId) : null
  const stock = variant?.stock
  if (!product || !variant || next > stock) throw new HttpError(409, 'INSUFFICIENT_STOCK', `Only ${stock ?? 0} in stock.`)
  item.quantity = next
  await cart.save()
  await respond(request, response)
}))

router.delete('/items/:itemId', asyncHandler(async (request, response) => {
  const itemId = parseId(request.params.itemId, 'cart item id')
  const cart = await loadCart(cartIdentity(request))
  cart.items.pull(itemId)
  await cart.save()
  await respond(request, response)
}))

router.delete('/', asyncHandler(async (request, response) => {
  const cart = await loadCart(cartIdentity(request))
  cart.items = []
  await cart.save()
  await respond(request, response)
}))

// Called right after sign-in to fold the guest cart into the account cart.
router.post('/merge', requireAuth, asyncHandler(async (request, response) => {
  const guestId = request.get('x-guest-id')
  if (guestId && /^[A-Za-z0-9_-]{16,64}$/.test(guestId)) await mergeGuestCart(request.user._id, guestId)
  const cart = await loadCart({ user: request.user._id })
  response.json({ cart: cartView(cart) })
}))

export default router
