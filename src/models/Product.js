import mongoose from 'mongoose'
import { variantFinalAmount, variantLabel } from '../utils/pricing.js'

// Every product is sold through one or more variants. Price, purchasing cost, discount, stock,
// image, colour and size all live on the variant (a plain product just has one "Standard" variant).
const variantSchema = new mongoose.Schema({
  color: { type: String, trim: true, maxlength: 40 },
  size: { type: String, trim: true, maxlength: 40 },
  sku: { type: String, trim: true, maxlength: 60 },
  sellingAmount: { type: Number, required: true, min: 0 },
  costAmount: { type: Number, required: true, min: 0 },
  discountPercent: { type: Number, min: 0, max: 100, default: 0 },
  stock: { type: Number, min: 0, default: 0 },
  image: { publicId: String, secureUrl: String },
  status: { type: String, enum: ['active', 'archived'], default: 'active' },
}, { _id: true })

variantSchema.virtual('finalAmount').get(function finalAmount() { return variantFinalAmount(this) })
variantSchema.virtual('label').get(function label() { return variantLabel(this) })

const productSchema = new mongoose.Schema({
  name: { type: String, required: true, trim: true, maxlength: 180 },
  slug: { type: String, required: true, unique: true, lowercase: true },
  description: { type: String, required: true, trim: true, maxlength: 5000 },
  category: { type: mongoose.Schema.Types.ObjectId, ref: 'Category', required: true, index: true },
  variants: {
    type: [variantSchema],
    default: [],
    validate: { validator: (variants) => variants.length > 0, message: 'A product needs at least one variant.' },
  },
  // Denormalised from the active variants so the shop can sort and filter by price with an index.
  priceFrom: { type: Number, default: null },
  priceTo: { type: Number, default: null },
  isFeatured: { type: Boolean, default: false, index: true },
  isNewArrival: { type: Boolean, default: false, index: true },
  status: { type: String, enum: ['draft', 'published', 'archived'], default: 'draft', index: true },
  ratingAverage: { type: Number, min: 0, max: 5, default: 0 },
  ratingCount: { type: Number, min: 0, default: 0 },
  publishedAt: Date,
}, { timestamps: true })

productSchema.pre('validate', function syncPriceRange() {
  const prices = this.variants.filter((variant) => variant.status === 'active').map(variantFinalAmount)
  this.priceFrom = prices.length ? Math.min(...prices) : null
  this.priceTo = prices.length ? Math.max(...prices) : null
})

productSchema.set('toJSON', { virtuals: true })
productSchema.index({ status: 1, createdAt: -1 })
productSchema.index({ status: 1, priceFrom: 1 })

export default mongoose.model('Product', productSchema)
