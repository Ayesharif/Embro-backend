import { Router } from 'express'
import Category from '../../models/Category.js'
import InventoryMovement from '../../models/InventoryMovement.js'
import Product from '../../models/Product.js'
import { env } from '../../config/env.js'
import { asyncHandler, HttpError } from '../../utils/httpError.js'
import { escapeRegex, slugify } from '../../utils/text.js'
import { parse, parseId, v } from '../../utils/validation.js'
import { onCategoryChange, onProductChange, onShippingChange } from '../../cache/namespaces.js'
import { destroyImage } from '../../services/cloudinary.js'
import { serializeAdminProduct } from '../../services/products.js'
import ShippingMethod from '../../models/ShippingMethod.js'

const router = Router()

const slugPattern = /^[a-z0-9]+(?:-[a-z0-9]+)*$/
// Image URLs must point at our own Cloudinary account so an admin form can't be used to embed arbitrary hosts.
const imageUrl = v.custom((value) => {
  if (typeof value !== 'string' || !value.startsWith('https://')) return 'must be an https URL.'
  const prefix = env.cloudinary.cloudName ? `https://res.cloudinary.com/${env.cloudinary.cloudName}/` : null
  return prefix && !value.startsWith(prefix) ? 'must be hosted on the configured Cloudinary account.' : null
})

const imageFields = { publicId: v.string({ max: 200 }), secureUrl: imageUrl }

const variantSchema = {
  id: v.optional(v.objectId()),
  color: v.optional(v.string({ min: 0, max: 40 })),
  size: v.optional(v.string({ min: 0, max: 40 })),
  sku: v.optional(v.string({ min: 0, max: 60 })),
  sellingAmount: v.integer({ min: 0, max: 100_000_000 }),
  costAmount: v.integer({ min: 0, max: 100_000_000 }),
  discountPercent: v.optional(v.integer({ min: 0, max: 100 })),
  stock: v.integer({ min: 0, max: 1_000_000 }),
  image: v.optional(v.nullable(v.object(imageFields))),
  status: v.optional(v.oneOf(['active', 'archived'])),
}
const productSchema = {
  name: v.string({ min: 2, max: 180 }),
  slug: v.optional(v.string({ min: 2, max: 100, pattern: slugPattern })),
  description: v.string({ min: 1, max: 5000 }),
  categoryId: v.objectId(),
  status: v.oneOf(['draft', 'published', 'archived']),
  isFeatured: v.boolean(),
  isNewArrival: v.boolean(),
  variants: v.array(v.object(variantSchema), { min: 1, max: 100 }),
}

async function uniqueSlug(base, excludeId) {
  const root = slugify(base) || 'product'
  for (let attempt = 0; attempt < 20; attempt += 1) {
    const candidate = attempt === 0 ? root : `${root}-${attempt + 1}`
    const clash = await Product.exists({ slug: candidate, ...(excludeId ? { _id: { $ne: excludeId } } : {}) })
    if (!clash) return candidate
  }
  throw new HttpError(409, 'SLUG_TAKEN', 'Could not generate a unique URL for this product. Provide a slug.')
}

// Existing variants keep their _id so carts and past orders that reference them stay valid.
function mapVariants(variants) {
  return variants.map(({ id, image, ...variant }) => ({
    ...(id ? { _id: id } : {}),
    ...variant,
    color: variant.color || undefined,
    size: variant.size || undefined,
    image: image ? { publicId: image.publicId, secureUrl: image.secureUrl } : undefined,
  }))
}

function assertVariants(variants, status) {
  const active = variants.filter((variant) => (variant.status || 'active') === 'active')
  if (status === 'published' && !active.length) {
    throw new HttpError(400, 'VALIDATION_ERROR', 'A published product needs at least one active variant.')
  }
  const seen = new Set()
  for (const variant of active) {
    const key = `${(variant.color || '').toLowerCase()}|${(variant.size || '').toLowerCase()}`
    if (seen.has(key)) throw new HttpError(400, 'VALIDATION_ERROR', 'Two active variants have the same colour and size.')
    seen.add(key)
  }
}

async function assertCategory(categoryId) {
  if (!await Category.exists({ _id: categoryId })) throw new HttpError(400, 'INVALID_CATEGORY', 'The selected category does not exist.')
}

router.get('/products', asyncHandler(async (request, response) => {
  const { q, status, page = 1, limit = 100 } = parse({
    q: v.optional(v.string({ min: 1, max: 80 })),
    status: v.optional(v.oneOf(['draft', 'published', 'archived'])),
    page: v.optional(v.integer({ min: 1, max: 10000, coerce: true })),
    limit: v.optional(v.integer({ min: 1, max: 200, coerce: true })),
  }, request.query)
  const filter = {}
  if (q) filter.name = { $regex: escapeRegex(q), $options: 'i' }
  if (status) filter.status = status
  const [total, products] = await Promise.all([
    Product.countDocuments(filter),
    Product.find(filter).populate('category', 'name slug').sort({ createdAt: -1 }).skip((page - 1) * limit).limit(limit),
  ])
  response.json({ data: products.map(serializeAdminProduct), pagination: { page, limit, total, totalPages: Math.max(1, Math.ceil(total / limit)) } })
}))

router.post('/products', asyncHandler(async (request, response) => {
  const input = parse({ ...productSchema, status: v.optional(productSchema.status), isFeatured: v.optional(productSchema.isFeatured), isNewArrival: v.optional(productSchema.isNewArrival) }, request.body)
  await assertCategory(input.categoryId)
  assertVariants(input.variants, input.status)
  const { categoryId, variants, ...rest } = input
  const product = await Product.create({
    ...rest,
    category: categoryId,
    slug: await uniqueSlug(rest.slug || rest.name),
    variants: mapVariants(variants),
    publishedAt: rest.status === 'published' ? new Date() : undefined,
  })
  await onProductChange()
  await product.populate('category', 'name slug')
  response.status(201).json({ product: serializeAdminProduct(product) })
}))

router.patch('/products/:id', asyncHandler(async (request, response) => {
  const id = parseId(request.params.id, 'product id')
  const changes = parse(productSchema, request.body, { partial: true })
  const product = await Product.findById(id)
  if (!product) throw new HttpError(404, 'PRODUCT_NOT_FOUND', 'Product not found.')
  const { categoryId, variants, slug, ...rest } = changes

  const previousStock = new Map(product.variants.map((variant) => [variant.id, variant.stock]))
  const previousImages = product.variants.map((variant) => variant.image?.publicId).filter(Boolean)

  if (categoryId) {
    await assertCategory(categoryId)
    product.category = categoryId
  }
  if (slug && slug !== product.slug) product.slug = await uniqueSlug(slug, id)
  if (variants) product.variants = mapVariants(variants)
  if (rest.status === 'published' && product.status !== 'published') product.publishedAt = new Date()
  Object.assign(product, rest)
  assertVariants(product.variants, product.status)
  await product.save()

  // Keep a stock ledger for manual edits, and delete variant images that are no longer used.
  for (const variant of product.variants) {
    const delta = variant.stock - (previousStock.get(variant.id) ?? 0)
    if (delta) await InventoryMovement.create({ product: product._id, variantId: variant._id, quantityDelta: delta, reason: 'manual edit', actor: request.user._id })
  }
  const stillUsed = new Set(product.variants.map((variant) => variant.image?.publicId).filter(Boolean))
  await Promise.all(previousImages.filter((publicId) => !stillUsed.has(publicId)).map(destroyImage))
  await onProductChange()

  await product.populate('category', 'name slug')
  response.json({ product: serializeAdminProduct(product) })
}))

router.delete('/products/:id', asyncHandler(async (request, response) => {
  const product = await Product.findByIdAndUpdate(parseId(request.params.id, 'product id'), { $set: { status: 'archived' } }, { new: true })
  if (!product) throw new HttpError(404, 'PRODUCT_NOT_FOUND', 'Product not found.')
  await onProductChange()
  response.json({ product: { id: product.id, status: product.status } })
}))

// Applies one discount to every variant. Documents are saved (not bulk-updated) so the
// denormalised price range stays correct.
router.post('/products/bulk-discount', asyncHandler(async (request, response) => {
  const { discountPercent, categoryId } = parse({ discountPercent: v.integer({ min: 0, max: 100 }), categoryId: v.optional(v.objectId()) }, request.body)
  const products = await Product.find({ status: { $ne: 'archived' }, ...(categoryId ? { category: categoryId } : {}) })
  for (const product of products) {
    product.variants.forEach((variant) => { variant.discountPercent = discountPercent })
    await product.save()
  }
  await onProductChange()
  response.json({ updated: products.length })
}))

router.post('/inventory/:productId/adjust', asyncHandler(async (request, response) => {
  const productId = parseId(request.params.productId, 'product id')
  const { quantityDelta, reason, variantId } = parse({
    quantityDelta: v.integer({ min: -1_000_000, max: 1_000_000 }),
    reason: v.string({ min: 3, max: 120 }),
    variantId: v.objectId(),
  }, request.body)
  const product = await Product.findOneAndUpdate(
    { _id: productId, variants: { $elemMatch: { _id: variantId, stock: { $gte: -quantityDelta } } } },
    { $inc: { 'variants.$.stock': quantityDelta } },
    { new: true },
  )
  if (!product) throw new HttpError(409, 'INSUFFICIENT_STOCK', 'Stock cannot become negative.')
  await InventoryMovement.create({ product: product._id, variantId, quantityDelta, reason, actor: request.user._id })
  await onProductChange()
  response.json({ product: { id: product.id, variantId, stock: product.variants.id(variantId).stock } })
}))

const categorySchema = {
  name: v.string({ min: 2, max: 80 }),
  slug: v.optional(v.string({ min: 2, max: 80, pattern: slugPattern })),
  description: v.optional(v.string({ min: 0, max: 1000 })),
  image: v.nullable(v.object(imageFields)),
  status: v.oneOf(['active', 'archived']),
  sortOrder: v.integer({ min: 0, max: 10000 }),
}

// Applies an image change (new upload, replacement or removal) and cleans up the old Cloudinary file.
async function applyImage(document, image) {
  const previous = document.image?.publicId
  document.image = image === null ? undefined : image
  return previous && previous !== image?.publicId ? previous : null
}

router.get('/categories', asyncHandler(async (request, response) => {
  response.json({ data: await Category.find().sort({ sortOrder: 1, name: 1 }) })
}))

router.post('/categories', asyncHandler(async (request, response) => {
  const input = parse({ ...categorySchema, status: v.optional(categorySchema.status), sortOrder: v.optional(categorySchema.sortOrder), image: v.optional(v.object(imageFields)) }, request.body)
  const category = await Category.create({ ...input, slug: input.slug || slugify(input.name) })
  await onCategoryChange()
  response.status(201).json({ category })
}))

router.patch('/categories/:id', asyncHandler(async (request, response) => {
  const { image, ...changes } = parse(categorySchema, request.body, { partial: true })
  const category = await Category.findById(parseId(request.params.id, 'category id'))
  if (!category) throw new HttpError(404, 'CATEGORY_NOT_FOUND', 'Category not found.')
  Object.assign(category, changes)
  const orphan = image !== undefined ? await applyImage(category, image) : null
  await category.save()
  await destroyImage(orphan)
  await onCategoryChange()
  response.json({ category })
}))

router.delete('/categories/:id', asyncHandler(async (request, response) => {
  const category = await Category.findByIdAndUpdate(parseId(request.params.id, 'category id'), { $set: { status: 'archived' } }, { new: true })
  if (!category) throw new HttpError(404, 'CATEGORY_NOT_FOUND', 'Category not found.')
  await onCategoryChange()
  response.json({ category })
}))

const shippingSchema = {
  name: v.string({ min: 2, max: 80 }),
  description: v.optional(v.string({ min: 0, max: 200 })),
  amount: v.integer({ min: 0, max: 10_000_000 }),
  estimatedDaysMin: v.integer({ min: 0, max: 90 }),
  estimatedDaysMax: v.integer({ min: 0, max: 90 }),
  isActive: v.boolean(),
  image: v.nullable(v.object(imageFields)),
}

function assertDays(method) {
  if (method.estimatedDaysMin > method.estimatedDaysMax) {
    throw new HttpError(400, 'VALIDATION_ERROR', 'Minimum delivery days cannot be greater than the maximum.')
  }
}

async function uniqueShippingCode(name) {
  const root = slugify(name) || 'shipping'
  for (let attempt = 0; attempt < 20; attempt += 1) {
    const candidate = attempt === 0 ? root : `${root}-${attempt + 1}`
    if (!await ShippingMethod.exists({ code: candidate })) return candidate
  }
  throw new HttpError(409, 'DUPLICATE', 'Could not generate a unique code for this shipping method.')
}

router.get('/shipping-methods', asyncHandler(async (request, response) => {
  response.json({ data: await ShippingMethod.find().sort({ amount: 1, name: 1 }) })
}))

router.post('/shipping-methods', asyncHandler(async (request, response) => {
  const input = parse({ ...shippingSchema, isActive: v.optional(shippingSchema.isActive), image: v.optional(v.object(imageFields)) }, request.body)
  assertDays(input)
  const method = await ShippingMethod.create({ ...input, code: await uniqueShippingCode(input.name) })
  await onShippingChange()
  response.status(201).json({ method })
}))

router.patch('/shipping-methods/:id', asyncHandler(async (request, response) => {
  const { image, ...changes } = parse(shippingSchema, request.body, { partial: true })
  const method = await ShippingMethod.findById(parseId(request.params.id, 'shipping method id'))
  if (!method) throw new HttpError(404, 'SHIPPING_METHOD_NOT_FOUND', 'Shipping method not found.')
  Object.assign(method, changes)
  assertDays(method)
  const orphan = image !== undefined ? await applyImage(method, image) : null
  await method.save()
  await destroyImage(orphan)
  await onShippingChange()
  response.json({ method })
}))

// Past orders keep their own copy of the method name and price, so deleting is safe.
router.delete('/shipping-methods/:id', asyncHandler(async (request, response) => {
  const method = await ShippingMethod.findByIdAndDelete(parseId(request.params.id, 'shipping method id'))
  if (!method) throw new HttpError(404, 'SHIPPING_METHOD_NOT_FOUND', 'Shipping method not found.')
  await destroyImage(method.image?.publicId)
  await onShippingChange()
  response.status(204).end()
}))

export default router
