import mongoose from 'mongoose'
import Product from '../models/Product.js'
import Review from '../models/Review.js'
import { variantFinalAmount, variantLabel } from '../utils/pricing.js'

function serializeCategory(category) {
  if (!category) return null
  if (category instanceof mongoose.Types.ObjectId || typeof category === 'string') return { id: String(category) }
  return { id: category.id || String(category._id), name: category.name, slug: category.slug }
}

const unique = (values) => [...new Set(values.filter(Boolean))]

// Explicit whitelist - the public API never exposes purchasing cost or internal fields.
export function serializeProduct(product) {
  const variants = product.variants.filter((variant) => variant.status === 'active')
  const cheapest = variants.reduce((best, variant) => (!best || variantFinalAmount(variant) < variantFinalAmount(best) ? variant : best), null)
  const stock = variants.reduce((sum, variant) => sum + variant.stock, 0)
  return {
    id: product.id,
    name: product.name,
    slug: product.slug,
    description: product.description,
    category: serializeCategory(product.category),
    // "From" price: the cheapest active variant.
    finalAmount: cheapest ? variantFinalAmount(cheapest) : 0,
    sellingAmount: cheapest?.sellingAmount || 0,
    discountPercent: cheapest?.discountPercent || 0,
    hasPriceRange: product.priceFrom !== product.priceTo,
    image: variants.find((variant) => variant.image?.secureUrl)?.image.secureUrl,
    colors: unique(variants.map((variant) => variant.color)),
    sizes: unique(variants.map((variant) => variant.size)),
    variants: variants.map((variant) => ({
      id: variant.id,
      color: variant.color,
      size: variant.size,
      label: variantLabel(variant),
      sellingAmount: variant.sellingAmount,
      finalAmount: variantFinalAmount(variant),
      discountPercent: variant.discountPercent,
      stock: variant.stock,
      image: variant.image?.secureUrl,
    })),
    stock,
    inStock: stock > 0,
    isFeatured: product.isFeatured,
    isNewArrival: product.isNewArrival,
    ratingAverage: product.ratingAverage,
    ratingCount: product.ratingCount,
    createdAt: product.createdAt,
  }
}

// Admin view: the storefront data plus purchasing cost, SKUs, status and archived variants.
export function serializeAdminProduct(product) {
  const all = product.variants
  return {
    ...serializeProduct(product),
    status: product.status,
    variants: all.map((variant) => ({
      id: variant.id,
      color: variant.color,
      size: variant.size,
      label: variantLabel(variant),
      sku: variant.sku,
      sellingAmount: variant.sellingAmount,
      costAmount: variant.costAmount,
      discountPercent: variant.discountPercent,
      finalAmount: variantFinalAmount(variant),
      stock: variant.stock,
      image: variant.image?.secureUrl ? { publicId: variant.image.publicId, secureUrl: variant.image.secureUrl } : null,
      status: variant.status,
    })),
    updatedAt: product.updatedAt,
  }
}

export async function recalculateRating(productId) {
  const [result] = await Review.aggregate([
    { $match: { product: new mongoose.Types.ObjectId(productId), status: 'approved' } },
    { $group: { _id: '$product', average: { $avg: '$rating' }, count: { $sum: 1 } } },
  ])
  await Product.updateOne(
    { _id: productId },
    { $set: { ratingAverage: result ? Math.round(result.average * 10) / 10 : 0, ratingCount: result?.count || 0 } },
  )
}
