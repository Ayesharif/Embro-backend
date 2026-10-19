import mongoose from 'mongoose'

const itemSchema = new mongoose.Schema({
  product: { type: mongoose.Schema.Types.ObjectId, ref: 'Product', required: true },
  variantId: mongoose.Schema.Types.ObjectId,
  quantity: { type: Number, min: 1, max: 20, required: true },
}, { _id: true })

const cartSchema = new mongoose.Schema({
  user: { type: mongoose.Schema.Types.ObjectId, ref: 'User', unique: true, sparse: true },
  guestId: { type: String, index: true, maxlength: 64 },
  items: { type: [itemSchema], default: [] },
}, { timestamps: true })

// Abandoned guest carts are removed after 30 days; signed-in carts are kept.
cartSchema.index({ updatedAt: 1 }, { expireAfterSeconds: 60 * 60 * 24 * 30, partialFilterExpression: { guestId: { $exists: true } } })

export default mongoose.model('Cart', cartSchema)
