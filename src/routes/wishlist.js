import { Router } from 'express'
import Product from '../models/Product.js'
import Wishlist from '../models/Wishlist.js'
import { asyncHandler, HttpError } from '../utils/httpError.js'
import { parse, parseId, v } from '../utils/validation.js'
import { requireAuth } from '../middleware/auth.js'
import { serializeProduct } from '../services/products.js'

const router = Router()
router.use(requireAuth)

async function view(userId) {
  const wishlist = await Wishlist.findOne({ user: userId })
  const products = wishlist?.products.length
    ? await Product.find({ _id: { $in: wishlist.products }, status: 'published' }).populate('category', 'name slug')
    : []
  return products.map(serializeProduct)
}

router.get('/', asyncHandler(async (request, response) => response.json({ data: await view(request.user._id) })))

router.post('/items', asyncHandler(async (request, response) => {
  const { productId } = parse({ productId: v.objectId() }, request.body)
  if (!await Product.exists({ _id: productId, status: 'published' })) throw new HttpError(404, 'PRODUCT_NOT_FOUND', 'Product not found.')
  await Wishlist.updateOne({ user: request.user._id }, { $addToSet: { products: productId } }, { upsert: true })
  response.status(201).json({ data: await view(request.user._id) })
}))

router.delete('/items/:productId', asyncHandler(async (request, response) => {
  await Wishlist.updateOne({ user: request.user._id }, { $pull: { products: parseId(request.params.productId, 'product id') } })
  response.json({ data: await view(request.user._id) })
}))

router.delete('/', asyncHandler(async (request, response) => {
  await Wishlist.updateOne({ user: request.user._id }, { $set: { products: [] } })
  response.json({ data: [] })
}))

export default router
