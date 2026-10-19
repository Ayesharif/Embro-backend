import Cart from '../models/Cart.js'
import { HttpError } from '../utils/httpError.js'
import { variantFinalAmount, variantLabel } from '../utils/pricing.js'

const GUEST_ID = /^[A-Za-z0-9_-]{16,64}$/
export const MAX_LINE_QUANTITY = 20

// Signed-in users get a cart keyed by user id; guests by a random id their browser generated.
// There is deliberately no shared fallback id: that used to give every anonymous visitor the same cart.
export function cartIdentity(request, { required = true } = {}) {
  if (request.user) return { user: request.user._id }
  const guestId = request.get('x-guest-id')
  if (guestId && GUEST_ID.test(guestId)) return { guestId }
  if (required) throw new HttpError(400, 'GUEST_ID_REQUIRED', 'A valid X-Guest-Id header is required for guest carts.')
  return null
}

export async function loadCart(identity, { create = true } = {}) {
  let cart = await Cart.findOne(identity)
  if (!cart && create) {
    try {
      cart = await Cart.create({ ...identity, items: [] })
    } catch (error) {
      if (error?.code !== 11000) throw error
      cart = await Cart.findOne(identity)
    }
  }
  if (cart) await cart.populate('items.product')
  return cart
}

function describeItem(item) {
  const product = item.product
  if (!product || product.status !== 'published') {
    return { id: item.id, productId: item.product?.id, quantity: item.quantity, name: product?.name || 'Unavailable product', unavailable: true, unavailableReason: 'This product is no longer available.' }
  }
  const variant = item.variantId ? product.variants.id(item.variantId) : null
  if (!variant || variant.status !== 'active') {
    return { id: item.id, productId: product.id, quantity: item.quantity, name: product.name, unavailable: true, unavailableReason: 'This option is no longer available.' }
  }
  const unit = variantFinalAmount(variant)
  const label = variantLabel(variant)
  const fallbackImage = product.variants.find((candidate) => candidate.image?.secureUrl)?.image.secureUrl
  return {
    id: item.id,
    productId: product.id,
    variantId: String(variant._id),
    // A product with a single "Standard" variant needs no label in the cart.
    variantLabel: label === 'Standard' ? undefined : label,
    name: product.name,
    slug: product.slug,
    image: variant.image?.secureUrl || fallbackImage,
    unitAmount: unit,
    originalUnitAmount: variant.discountPercent > 0 ? variant.sellingAmount : undefined,
    quantity: item.quantity,
    lineTotalAmount: unit * item.quantity,
    stockAvailable: variant.stock,
    outOfStock: item.quantity > variant.stock,
    sku: variant.sku,
    unavailable: false,
  }
}

export function cartView(cart) {
  const items = cart ? cart.items.map(describeItem) : []
  const subtotalAmount = items.filter((item) => !item.unavailable).reduce((sum, item) => sum + item.lineTotalAmount, 0)
  return {
    id: cart?.id,
    items,
    itemCount: items.filter((item) => !item.unavailable).reduce((sum, item) => sum + item.quantity, 0),
    subtotalAmount,
    hasProblems: items.some((item) => item.unavailable || item.outOfStock),
  }
}

// Used by checkout: refuses to price a cart that has unavailable or out-of-stock lines.
export function priceableLines(cart) {
  if (!cart || !cart.items.length) throw new HttpError(400, 'EMPTY_CART', 'Your cart is empty.')
  const lines = cartView(cart).items
  for (const line of lines) {
    if (line.unavailable) throw new HttpError(409, 'CART_ITEM_UNAVAILABLE', `${line.name}: ${line.unavailableReason} Remove it from your cart to continue.`)
    if (line.outOfStock) throw new HttpError(409, 'INSUFFICIENT_STOCK', `Only ${line.stockAvailable} of "${line.name}" ${line.stockAvailable === 1 ? 'is' : 'are'} in stock.`)
  }
  return lines
}

export async function mergeGuestCart(userId, guestId) {
  const guest = await Cart.findOne({ guestId })
  if (!guest) return
  const cart = (await Cart.findOne({ user: userId })) || new Cart({ user: userId, items: [] })
  for (const item of guest.items) {
    const same = cart.items.find((existing) => String(existing.product) === String(item.product) && String(existing.variantId || '') === String(item.variantId || ''))
    if (same) same.quantity = Math.min(MAX_LINE_QUANTITY, same.quantity + item.quantity)
    else cart.items.push({ product: item.product, variantId: item.variantId, quantity: item.quantity })
  }
  await cart.save()
  await guest.deleteOne()
}
